import fs from "node:fs/promises";
import { ensureDir } from "./util";
import { FONTS_DIR } from "./fonts";
import type { Project, Subtitles } from "./store";

export const SUBTITLE_PRESETS: Record<string, Partial<Subtitles>> = {
  classique: {
    font: "Segoe UI",
    fontSize: 54,
    textColor: "#ffffff",
    highlightColor: "#ffb02e",
    outlineColor: "#000000",
    outlineWidth: 3,
    position: "bottom",
    animation: "fade",
    uppercase: false,
    background: false,
    karaoke: false,
  },
  karaoke: {
    font: "Segoe UI",
    fontSize: 58,
    textColor: "#ffffff",
    highlightColor: "#ffb02e",
    outlineColor: "#000000",
    outlineWidth: 4,
    position: "middle",
    animation: "none",
    uppercase: false,
    background: false,
    karaoke: true,
  },
  lyrics: {
    font: "Georgia",
    fontSize: 64,
    textColor: "#ffffff",
    highlightColor: "#ffffff",
    outlineColor: "#000000",
    outlineWidth: 2,
    position: "middle",
    animation: "pop",
    uppercase: false,
    background: false,
    karaoke: false,
  },
  neon: {
    font: "Impact",
    fontSize: 66,
    textColor: "#ffe45e",
    highlightColor: "#ff4d6d",
    outlineColor: "#1a1030",
    outlineWidth: 6,
    position: "bottom",
    animation: "pop",
    uppercase: true,
    background: false,
    karaoke: false,
  },
  minimal: {
    font: "Verdana",
    fontSize: 44,
    textColor: "#f2f6ff",
    highlightColor: "#4da3ff",
    outlineColor: "#000000",
    outlineWidth: 1,
    position: "bottom",
    animation: "slide",
    uppercase: false,
    background: true,
    karaoke: false,
  },
};

export function defaultSubtitles(): Subtitles {
  return {
    enabled: false,
    preset: "classique",
    font: "Segoe UI",
    fontSize: 54,
    textColor: "#ffffff",
    highlightColor: "#ffb02e",
    outlineColor: "#000000",
    outlineWidth: 3,
    position: "bottom",
    animation: "fade",
    uppercase: false,
    background: false,
    karaoke: false,
    maxWordsPerLine: 6,
    marginBottom: 70,
  };
}

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

/** Regroupe les mots en lignes de sous-titres. */
export function subtitleLines(project: Project, maxWords: number) {
  const transcript = project.transcript;
  if (!transcript) return [];
  const lines: { start: number; end: number; words: { w: string; s: number; e: number }[] }[] = [];
  const limit = Math.max(1, Math.min(12, maxWords || 6));
  let current: { start: number; end: number; words: { w: string; s: number; e: number }[] } | null = null;
  let lastSegmentId = "";
  const push = () => {
    if (current && current.words.length) lines.push(current);
    current = null;
  };
  for (const segment of transcript.segments) {
    for (const word of segment.words || []) {
      if (!/[\p{L}\p{N}]/u.test(word.w || "")) continue;
      const newLine =
        !current ||
        current.words.length >= limit ||
        segment.id !== lastSegmentId ||
        word.s - current.start > 6.5;
      if (newLine) {
        push();
        current = { start: word.s, end: word.e, words: [] };
      }
      current!.words.push({ ...word });
      current!.end = Math.max(current!.end, word.e);
      lastSegmentId = segment.id;
    }
    push();
  }
  push();
  return lines;
}

export function buildAss(project: Project, width: number, height: number): string {
  const s = { ...defaultSubtitles(), ...(project.subtitles || {}) };
  const scale = height / 1080;
  const fontSize = Math.max(16, Math.round((s.fontSize || 54) * scale));
  const outline = Math.max(0, (s.outlineWidth || 3) * scale);
  const marginV = Math.max(10, Math.round((s.marginBottom ?? 70) * scale));
  const alignment = s.position === "top" ? 8 : s.position === "middle" ? 5 : 2;
  const maxWords = s.maxWordsPerLine || 6;
  const primary = hexToAss(s.textColor);
  const secondary = s.karaoke ? hexToAss(s.textColor) : hexToAss(s.textColor);
  const highlight = hexToAss(s.highlightColor);
  const outlineColor = hexToAss(s.outlineColor);
  const back = s.background ? "&H99000000" : "&H00000000";
  const borderStyle = s.background ? 3 : 1;

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 2
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${s.font || "Segoe UI"},${fontSize},${s.karaoke ? highlight : primary},${secondary},${outlineColor},${back},-1,0,0,0,100,100,0,0,${borderStyle},${outline},${s.background ? 0 : 1},${alignment},60,60,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const lines = subtitleLines(project, maxWords);
  const events: string[] = [];
  for (const line of lines) {
    const start = line.start;
    const end = Math.max(line.end + 0.12, line.start + 0.4);
    let animation = "";
    if (s.animation === "fade") animation = "\\fad(140,140)";
    else if (s.animation === "pop") animation = "\\fad(100,100)\\fscx70\\fscy70\\t(0,170,\\fscx100\\fscy100)";
    else if (s.animation === "slide") {
      const x = Math.round(width / 2);
      const y = alignment === 2 ? height - marginV : alignment === 5 ? Math.round(height / 2) : marginV;
      animation = `\\fad(120,120)\\move(${x},${y + Math.round(40 * scale)},${x},${y},0,220)`;
    }
    let text: string;
    if (s.karaoke) {
      const parts: string[] = [];
      let cursor = start;
      for (const word of line.words) {
        const gap = Math.max(0, word.s - cursor);
        if (gap > 0.02) parts.push(`{\\k${Math.round(gap * 100)}}`);
        const duration = Math.max(0.05, word.e - Math.max(word.s, cursor));
        parts.push(`{\\k${Math.round(duration * 100)}}${assEscape(word.w)} `);
        cursor = word.e;
      }
      text = parts.join("");
    } else {
      text = line.words.map((w) => assEscape(w.w)).join(" ");
    }
    if (s.uppercase) text = text.toUpperCase();
    if (animation) text = `{${animation}}${text}`;
    events.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Default,,0,0,0,,${text}`);
  }
  return `${header}${events.join("\n")}\n`;
}

/**
 * Écrit le fichier .ass dans le dossier des polices: ffmpeg tourne ensuite dans
 * ce dossier (cwd), ce qui évite tout échappement de chemin dans le filtre
 * `ass=...:fontsdir=.` sous Windows.
 */
export async function writeSubtitles(project: Project, width: number, height: number): Promise<string | null> {
  if (!project.subtitles?.enabled) return null;
  if (!project.transcript) return null;
  const lines = subtitleLines(project, project.subtitles?.maxWordsPerLine || 6);
  if (!lines.length) return null;
  await ensureDir(FONTS_DIR);
  const file = "subtitles.ass";
  await fs.writeFile(`${FONTS_DIR}/${file}`, buildAss(project, width, height), "utf8");
  return file;
}
