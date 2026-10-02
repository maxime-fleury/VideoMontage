import fs from "node:fs/promises";
import { ensureDir } from "./util";
import { FONTS_DIR } from "./fonts";
import type { Box, Project, TextOverlay } from "./store";

/**
 * Textes libres : rendus par libass, comme les sous-titres, mais dans un second
 * fichier .ass (`texts.ass`) chaîné après eux. Avantages : les polices locales du
 * dossier `ttf/` sont déjà exploitables, et les animations (fondu, pop, glissement,
 * machine à écrire, surlignage mot par mot) s'écrivent en balises ASS.
 *
 * Les positions viennent du même modèle que les incrustations : un cadre en
 * fractions 0..1 du cadre de sortie, exactement ce que l'aperçu dessine en CSS.
 */

function hexToAss(hex: string, alpha = "00") {
  const clean = (hex || "#ffffff").replace("#", "").padEnd(6, "0").slice(0, 6);
  const r = clean.slice(0, 2);
  const g = clean.slice(2, 4);
  const b = clean.slice(4, 6);
  return `&H${alpha}${b}${g}${r}`.toUpperCase();
}

function assTime(seconds: number) {
  const t = Math.max(0, seconds);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const cs = Math.round((t - Math.floor(t)) * 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(Math.min(99, cs)).padStart(2, "0")}`;
}

function assEscape(text: string) {
  return text.replace(/\\/g, "\\\\").replace(/{/g, "(").replace(/}/g, ")").replace(/\r?\n/g, "\\N");
}

const ms = (seconds: number) => Math.max(0, Math.round(seconds * 1000));

/** Ancre horizontale d'un texte selon son alignement. */
function anchorX(box: Box, align: string, width: number) {
  if (align === "left") return box.x * width;
  if (align === "right") return (box.x + box.w) * width;
  return (box.x + box.w / 2) * width;
}

type TextEvent = { start: number; end: number; text: string; tags: string };

/** Décompose un texte en événements ASS selon son animation d'entrée/sortie. */
export function textEvents(text: TextOverlay, width: number, height: number): TextEvent[] {
  const start = Math.max(0, text.start);
  const duration = Math.max(0.05, text.duration);
  const end = start + duration;
  const style = text.style || ({} as TextOverlay["style"]);
  const animation = text.animation || { in: "fade", out: "fade", duration: 0.35 };
  const animDuration = Math.max(0.05, Math.min(animation.duration || 0.35, duration / 2));
  const align = style.align || "center";
  const x = Math.round(anchorX(text.box, align, width));
  const y = Math.round((text.box.y + text.box.h / 2) * height);
  const scale = height / 1080;
  const content = (style.uppercase ? text.text.toUpperCase() : text.text) || "";
  const lines = content.split(/\r?\n/);

  const base: string[] = [`\\an5`, `\\q2`];
  if (align === "left") base[0] = "\\an4";
  if (align === "right") base[0] = "\\an6";
  if (text.rotation) base.push(`\\frz${(-Number(text.rotation)).toFixed(2)}`);
  if (style.letterSpacing) base.push(`\\fsp${Number(style.letterSpacing).toFixed(1)}`);

  const outTags = () => {
    if (animation.out === "fade") return `\\fad(0,${ms(animDuration)})`;
    if (animation.out === "pop") return `\\t(${ms(end - animDuration)},${ms(end)},\\fscx88\\fscy88)\\fad(0,${Math.round(ms(animDuration) * 0.7)})`;
    if (animation.out === "slide") return `\\move(${x},${y},${x},${y + Math.round(24 * scale)},${ms(end - animDuration)},${ms(end)})\\fad(0,${ms(animDuration)})`;
    return "";
  };

  const out = outTags();
  const events: TextEvent[] = [];

  if (animation.in === "typewriter") {
    // Progression caractère par caractère : chaque événement montre un préfixe plus long.
    const chars = lines.join("\\N").split("");
    const steps = Math.max(1, Math.min(chars.length, 90));
    const typing = Math.max(0.08, duration * 0.7);
    const stepTime = typing / steps;
    for (let i = 0; i < steps; i++) {
      const shown = Math.max(1, Math.round(((i + 1) / steps) * chars.length));
      const evStart = start + i * stepTime;
      const evEnd = i === steps - 1 ? end : start + (i + 1) * stepTime;
      const tail = i === steps - 1 ? out : "";
      events.push({
        start: evStart,
        end: evEnd,
        text: chars.slice(0, shown).join(""),
        tags: [...base, `\\pos(${x},${y})`, tail].filter(Boolean).join(""),
      });
    }
    return events;
  }

  if (animation.in === "word-highlight") {
    // Surlignage mot par mot (karaoké) : le mot en cours prend la couleur de surlignage.
    const words = lines.join("\\N").split(/\s+/).filter(Boolean);
    const total = words.reduce((acc, w) => acc + Math.max(1, w.length), 0);
    let cursor = start;
    const parts: string[] = [];
    for (const word of words) {
      const share = Math.max(1, word.length) / total;
      const wordDuration = Math.max(0.08, duration * share);
      parts.push(`{\\k${Math.round(wordDuration * 100)}}${assEscape(word)} `);
      cursor += wordDuration;
    }
    events.push({
      start,
      end,
      text: parts.join(""),
      tags: [...base, `\\pos(${x},${y})`, `\\fad(${ms(animDuration) * 0.3},${ms(animDuration) * 0.3})`, out].filter(Boolean).join(""),
    });
    return events;
  }

  const inTags = (() => {
    switch (animation.in) {
      case "none":
        return "";
      case "pop":
        return `\\fad(${Math.round(ms(animDuration) * 0.6)},0)\\fscx60\\fscy60\\t(0,${ms(animDuration)},\\fscx100\\fscy100)`;
      case "slide-up":
        return `\\move(${x},${y + Math.round(60 * scale)},${x},${y},${ms(start)},${ms(start + animDuration)})`;
      case "slide-down":
        return `\\move(${x},${y - Math.round(60 * scale)},${x},${y},${ms(start)},${ms(start + animDuration)})`;
      case "slide-left":
        return `\\move(${x + Math.round(140 * scale)},${y},${x},${y},${ms(start)},${ms(start + animDuration)})`;
      case "slide-right":
        return `\\move(${x - Math.round(140 * scale)},${y},${x},${y},${ms(start)},${ms(start + animDuration)})`;
      default:
        return `\\fad(${ms(animDuration)},0)`;
    }
  })();

  events.push({
    start,
    end,
    text: assEscape(content),
    tags: [...base, `\\pos(${x},${y})`, inTags, out].filter(Boolean).join(""),
  });
  return events;
}

export function hasTexts(project: Project) {
  return (project.texts || []).some((t) => (t.text || "").trim().length > 0 && t.duration > 0.05);
}

export function buildTextsAss(project: Project, width: number, height: number): string {
  const texts = (project.texts || [])
    .filter((t) => (t.text || "").trim().length > 0)
    .slice()
    .sort((a, b) => (a.z || 0) - (b.z || 0) || a.start - b.start);
  const scale = height / 1080;
  const header: string[] = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "YCbCr Matrix: TV.709",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
  ];

  const events: string[] = [];
  texts.forEach((text, index) => {
    const style = text.style;
    const name = `T${index}`;
    const fontSize = Math.max(10, Math.round((style.size || 0.07) * height));
    const outline = Math.max(0, style.outlineWidth * scale);
    const shadow = Math.max(0, style.shadow * scale);
    const karaoke = text.animation?.in === "word-highlight";
    const primary = karaoke ? hexToAss(style.highlightColor || "#ffd166") : hexToAss(style.color);
    const secondary = karaoke ? hexToAss(style.color) : hexToAss(style.color);
    const back = style.background ? hexToAss(style.background, "60") : "&H00000000";
    const borderStyle = style.background ? 3 : 1;
    const padding = style.background ? Math.max(0, style.padding * scale) : 0;
    const marginSide = Math.max(0, Math.round(((1 - text.box.w) / 2) * width));
    header.push(
      `Style: ${name},${style.font || "Outfit"},${fontSize},${primary},${secondary},${hexToAss(style.outlineColor)},${back},` +
        `${style.bold ? -1 : 0},${style.italic ? -1 : 0},0,0,100,100,${Number(style.letterSpacing || 0).toFixed(1)},0,` +
        `${borderStyle},${Math.max(padding, outline)},${shadow},5,${marginSide},${marginSide},0,1`
    );

    for (const event of textEvents(text, width, height)) {
      events.push(
        `Dialogue: 0,${assTime(event.start)},${assTime(event.end)},${name},,0,0,0,,{${event.tags}}${event.text}`
      );
    }
  });

  if (!events.length) return "";
  return `${header.join("\n")}\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${events.join("\n")}\n`;
}

/**
 * Écrit `texts.ass` à côté de `subtitles.ass` (ffmpeg tourne dans ce dossier, avec
 * les TTF dans ./ttf → aucune échappement de chemin, y compris sous Windows).
 */
export async function writeTexts(project: Project, width: number, height: number): Promise<string | null> {
  if (!hasTexts(project)) return null;
  const content = buildTextsAss(project, width, height);
  if (!content) return null;
  await ensureDir(FONTS_DIR);
  const file = "texts.ass";
  await fs.writeFile(`${FONTS_DIR}/${file}`, content, "utf8");
  return file;
}
