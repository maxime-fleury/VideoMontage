import { S, emit, on, adoptProject } from "./state.js";
import { $, api, el, clamp, openModal, toast, watchJob } from "./api.js";

export let PRESETS = {};
let overlay = null;
let saveTimer = null;

const SYSTEM_FONTS = [
  "Segoe UI",
  "Arial",
  "Verdana",
  "Tahoma",
  "Trebuchet MS",
  "Georgia",
  "Times New Roman",
  "Impact",
  "Comic Sans MS",
  "Calibri",
  "Cambria",
];

/** Polices Google installées localement (data/fonts) + polices système. */
export let FONTS = [...SYSTEM_FONTS];
/** Libellé famille → note d'usage (« titres », « impact »…). */
export let FONT_NOTES = {};
let GOOGLE_FONTS = [];

/** Charge les polices et injecte les @font-face pour que l'aperçu soit fidèle. */
export async function loadFonts() {
  try {
    const data = await api("/api/fonts");
    GOOGLE_FONTS = data.fonts || [];
  } catch {
    GOOGLE_FONTS = [];
  }
  const styleId = "google-fonts-faces";
  let style = document.getElementById(styleId);
  if (!style) {
    style = document.createElement("style");
    style.id = styleId;
    document.head.append(style);
  }
  const installed = GOOGLE_FONTS.filter((f) => f.installed);
  const rules = [];
  for (const font of installed) {
    for (const file of font.files) {
      const name = typeof file === "string" ? file : file.name;
      const weight = typeof file === "string" ? 400 : file.weight || 400;
      rules.push(
        `@font-face{font-family:'${font.label}';font-weight:${weight};font-style:normal;` +
          `src:url('/fonts/${name}') format('truetype');font-display:swap;}`
      );
    }
  }
  style.textContent = rules.join("\n");
  FONTS = [...SYSTEM_FONTS, ...installed.map((f) => f.label)];
  FONT_NOTES = Object.fromEntries(installed.filter((f) => f.note).map((f) => [f.label, f.note]));
  // Les éditeurs (textes libres) proposent le même catalogue de polices locales.
  S.fonts = FONTS;
  emit("fonts");
}

export function allGoogleFonts() {
  return GOOGLE_FONTS;
}

export async function loadSubtitles() {
  if (!S.project) return;
  try {
    const data = await api(`/api/projects/${S.project.id}/subtitles`);
    S.subtitleStyle = data.subtitles;
    PRESETS = data.presets || {};
    S.subtitleLines = data.lines || [];
  } catch {
    S.subtitleStyle = S.subtitleStyle || null;
    S.subtitleLines = [];
  }
  emit("subtitles");
}

export function initSubtitles() {
  overlay = el("div", { class: "subtitle-overlay", hidden: true });
  $("#stage").append(overlay);
  on("tick", updateSubtitleOverlay);
  loadFonts();
}

/** Sauvegarde différée du style de sous-titres. */
function persistSubtitles(immediate = false) {
  if (saveTimer) clearTimeout(saveTimer);
  const send = async () => {
    try {
      const { project } = await api(`/api/projects/${S.project.id}/update`, {
        method: "POST",
        body: { subtitles: S.subtitleStyle },
      });
      adoptProject({ ...S.project, subtitles: project.subtitles });
      emit("project-external", S.project);
    } catch (e) {
      toast(`Sous-titres : ${e.message}`, "error");
    }
  };
  if (immediate) send();
  else saveTimer = setTimeout(send, 400);
}

/** Applique un preset (valeurs serveur) sur le style courant. */
function applyPreset(name) {
  const preset = PRESETS[name];
  if (!preset) return;
  S.subtitleStyle = { ...S.subtitleStyle, ...preset, preset: name };
}

/** Modale complète de réglage des sous-titres (aperçu live sur la scène). */
export function openSubtitlesModal() {
  if (!S.subtitleStyle) {
    toast("Charge d'abord un projet", "error");
    return;
  }
  if (!S.subtitleLines?.length) {
    toast("La transcription est nécessaire pour afficher des sous-titres — lance 🗣️ Transcrire", "error", 9000);
  }
  const sync = () => {
    updateSubtitleOverlay();
    persistSubtitles();
  };
  const field = (label, node) => el("div", { class: "prop-row" }, [el("span", { text: label }), node]);

  const enable = el("input", { type: "checkbox", checked: S.subtitleStyle.enabled });
  enable.addEventListener("change", () => {
    S.subtitleStyle.enabled = enable.checked;
    sync();
  });

  const preset = el("select");
  for (const name of Object.keys(PRESETS)) preset.append(el("option", { value: name, text: name }));
  preset.append(el("option", { value: "perso", text: "personnalisé" }));
  preset.value = S.subtitleStyle.preset || "perso";
  preset.addEventListener("change", () => {
    if (preset.value !== "perso") applyPreset(preset.value);
    else S.subtitleStyle.preset = "perso";
    sync();
    rebuild();
  });

  const font = el("select");
  const fillFonts = () => {
    font.innerHTML = "";
    for (const name of FONTS)
      font.append(el("option", { value: name, text: FONT_NOTES[name] ? `${name} — ${FONT_NOTES[name]}` : name }));
    if (!FONTS.includes(S.subtitleStyle.font)) font.append(el("option", { value: S.subtitleStyle.font, text: `${S.subtitleStyle.font} (non installée)` }));
    font.value = S.subtitleStyle.font;
  };
  fillFonts();
  font.addEventListener("change", () => {
    S.subtitleStyle.font = font.value;
    S.subtitleStyle.preset = "perso";
    sync();
  });

  const missing = GOOGLE_FONTS.filter((f) => !f.installed);
  const fontTools = el("div", { class: "panel-actions" }, [
    missing.length
      ? el("button", {
          text: `⬇️ Installer les polices Google (${missing.length})`,
          onclick: async () => {
            const { job } = await api("/api/fonts", { method: "POST", body: { all: true } });
            const note = toast("Téléchargement des polices…", "info", 300000);
            watchJob(job, async (state) => {
              if (state.status === "running") {
                note.textContent = `Polices… ${Math.round(state.progress * 100)}% — ${state.message}`;
                return;
              }
              note.remove();
              toast(state.status === "done" ? "Polices installées ✓" : `Échec : ${state.error}`, state.status === "done" ? "ok" : "error");
              await loadFonts();
              fillFonts();
            });
          },
        })
      : el("span", { class: "muted", style: { fontSize: "11px" }, text: "Polices Google installées ✓" }),
  ]);

  const size = el("input", { type: "range", min: "24", max: "110", step: "1", value: String(S.subtitleStyle.fontSize) });
  const sizeVal = el("span", { class: "val", text: `${S.subtitleStyle.fontSize} px` });
  size.addEventListener("input", () => {
    S.subtitleStyle.fontSize = Number(size.value);
    sizeVal.textContent = `${size.value} px`;
    S.subtitleStyle.preset = "perso";
    sync();
  });

  const textColor = el("input", { type: "color", value: S.subtitleStyle.textColor, style: { width: "52px", padding: "2px" } });
  textColor.addEventListener("input", () => {
    S.subtitleStyle.textColor = textColor.value;
    S.subtitleStyle.preset = "perso";
    sync();
  });

  const highlight = el("input", { type: "color", value: S.subtitleStyle.highlightColor, style: { width: "52px", padding: "2px" } });
  highlight.addEventListener("input", () => {
    S.subtitleStyle.highlightColor = highlight.value;
    S.subtitleStyle.preset = "perso";
    sync();
  });

  const outlineColor = el("input", { type: "color", value: S.subtitleStyle.outlineColor, style: { width: "52px", padding: "2px" } });
  outlineColor.addEventListener("input", () => {
    S.subtitleStyle.outlineColor = outlineColor.value;
    S.subtitleStyle.preset = "perso";
    sync();
  });

  const outline = el("input", { type: "range", min: "0", max: "8", step: "0.5", value: String(S.subtitleStyle.outlineWidth) });
  const outlineVal = el("span", { class: "val", text: `${S.subtitleStyle.outlineWidth}` });
  outline.addEventListener("input", () => {
    S.subtitleStyle.outlineWidth = Number(outline.value);
    outlineVal.textContent = outline.value;
    S.subtitleStyle.preset = "perso";
    sync();
  });

  const position = el("select");
  for (const [value, label] of [
    ["bottom", "Bas"],
    ["middle", "Milieu (paroles)"],
    ["top", "Haut"],
  ])
    position.append(el("option", { value, text: label }));
  position.value = S.subtitleStyle.position;
  position.addEventListener("change", () => {
    S.subtitleStyle.position = position.value;
    S.subtitleStyle.preset = "perso";
    sync();
  });

  const animation = el("select");
  for (const [value, label] of [
    ["none", "Aucune (apparition franche)"],
    ["fade", "Fondu"],
    ["pop", "Zoom / pop"],
    ["slide", "Glissement vers le haut"],
  ])
    animation.append(el("option", { value, text: label }));
  animation.value = S.subtitleStyle.animation;
  animation.addEventListener("change", () => {
    S.subtitleStyle.animation = animation.value;
    S.subtitleStyle.preset = "perso";
    sync();
  });

  const words = el("input", { type: "range", min: "2", max: "10", step: "1", value: String(S.subtitleStyle.maxWordsPerLine) });
  const wordsVal = el("span", { class: "val", text: `${S.subtitleStyle.maxWordsPerLine} mots` });
  words.addEventListener("input", () => {
    S.subtitleStyle.maxWordsPerLine = Number(words.value);
    wordsVal.textContent = `${words.value} mots`;
    persistSubtitles();
  });
  words.addEventListener("change", async () => {
    await loadSubtitles();
    updateSubtitleOverlay();
    rebuild();
  });

  const karaoke = el("input", { type: "checkbox", checked: S.subtitleStyle.karaoke });
  karaoke.addEventListener("change", () => {
    S.subtitleStyle.karaoke = karaoke.checked;
    S.subtitleStyle.preset = "perso";
    sync();
  });

  const uppercase = el("input", { type: "checkbox", checked: S.subtitleStyle.uppercase });
  uppercase.addEventListener("change", () => {
    S.subtitleStyle.uppercase = uppercase.checked;
    S.subtitleStyle.preset = "perso";
    sync();
  });

  const background = el("input", { type: "checkbox", checked: S.subtitleStyle.background });
  background.addEventListener("change", () => {
    S.subtitleStyle.background = background.checked;
    S.subtitleStyle.preset = "perso";
    sync();
  });

  const margin = el("input", { type: "range", min: "0", max: "300", step: "5", value: String(S.subtitleStyle.marginBottom) });
  const marginVal = el("span", { class: "val", text: `${S.subtitleStyle.marginBottom} px` });
  margin.addEventListener("input", () => {
    S.subtitleStyle.marginBottom = Number(margin.value);
    marginVal.textContent = `${margin.value} px`;
    sync();
  });

  let close = null;
  const rebuild = () => {
    const body = el("div", {}, [
      el("h2", { text: "💬 Sous-titres" }),
      el("div", { class: "muted", style: { fontSize: "12px", marginBottom: "10px" }, text: "Les sous-titres sont calculés depuis la transcription et incrustés au rendu final (ils n'apparaissent pas dans les fichiers sources)." }),
      field("Activer les sous-titres", enable),
      field("Style prédéfini", preset),
      field("Police", font),
      fontTools,
      el("div", { class: "prop-row" }, [el("span", { text: "Taille" }), size, sizeVal]),
      field("Couleur du texte", textColor),
      field("Couleur des mots prononcés", highlight),
      field("Couleur du contour", outlineColor),
      el("div", { class: "prop-row" }, [el("span", { text: "Épaisseur du contour" }), outline, outlineVal]),
      field("Position", position),
      field("Animation", animation),
      el("div", { class: "prop-row" }, [el("span", { text: "Mots par ligne" }), words, wordsVal]),
      el("div", { class: "prop-row" }, [el("span", { text: "Marge (px à 1080p)" }), margin, marginVal]),
      field("Mode karaoké (surligne au fur et à mesure)", karaoke),
      field("Tout en majuscules", uppercase),
      field("Bandeau de fond", background),
      el("div", { class: "muted", style: { fontSize: "11px", marginTop: "8px" }, text: "L'aperçu en direct s'affiche dans la scène (en haut à gauche) à la position de la tête de lecture." }),
      el("div", { class: "divider" }),
      el("div", { class: "panel-title", text: "⬇️ Fichiers de sous-titres" }),
      el("div", {
        class: "muted",
        style: { fontSize: "11px", marginBottom: "6px" },
        text: S.subtitleLines?.length
          ? "Mêmes phrases et mêmes coupures que les sous-titres incrustés, prêts pour YouTube, Premiere ou DaVinci."
          : "Vide tant que la transcription n'a pas été lancée (🗣️ Transcrire).",
      }),
      el("div", { class: "panel-actions" }, [
        el("a", { href: `/api/projects/${S.project.id}/subtitles.srt`, download: "", style: { textDecoration: "none" } }, [
          el("button", { text: "⤓ .srt", title: "Sous-titres SubRip (timecodes à la virgule)" }),
        ]),
        el("a", { href: `/api/projects/${S.project.id}/subtitles.vtt`, download: "", style: { textDecoration: "none" } }, [
          el("button", { text: "⤓ .vtt", title: "WebVTT (timecodes au point)" }),
        ]),
      ]),
      el("div", { class: "footer" }, [
        el("button", { text: "Fermer", onclick: () => close?.() }),
        el("button", {
          class: "primary",
          text: "Enregistrer",
          onclick: () => {
            persistSubtitles(true);
            toast("Style de sous-titres enregistré", "ok");
            close?.();
          },
        }),
      ]),
    ]);
    close = openModal(() => body);
  };
  rebuild();
}

export function lineAt(t) {
  if (!S.subtitleLines?.length) return null;
  return S.subtitleLines.find((line) => t >= line.start - 0.05 && t <= line.end + 0.28) || null;
}

function applyStyle(node, style, stageHeight, outputHeight) {
  const scale = stageHeight / outputHeight;
  node.style.fontFamily = `"${style.font || "Segoe UI"}", sans-serif`;
  node.style.fontSize = `${Math.max(9, (style.fontSize || 54) * scale)}px`;
  node.style.color = style.textColor || "#fff";
  node.style.fontWeight = "700";
  node.style.textTransform = style.uppercase ? "uppercase" : "none";
  node.style.letterSpacing = "0.02em";
  node.style.background = style.background ? "rgba(0,0,0,0.6)" : "transparent";
  node.style.padding = style.background ? `${Math.max(2, 8 * scale)}px ${Math.max(4, 18 * scale)}px` : "0";
  node.style.borderRadius = style.background ? "8px" : "0";
  if (style.background) {
    node.style.textShadow = "none";
  } else {
    const w = Math.max(0, (style.outlineWidth || 0) * scale);
    const outline = style.outlineColor || "#000";
    node.style.textShadow =
      w > 0
        ? [
            `${-w}px 0 0 ${outline}`,
            `${w}px 0 0 ${outline}`,
            `0 ${-w}px 0 ${outline}`,
            `0 ${w}px 0 ${outline}`,
            `${-w}px ${-w}px 0 ${outline}`,
            `${w}px ${-w}px 0 ${outline}`,
            `${-w}px ${w}px 0 ${outline}`,
            `${w}px ${w}px 0 ${outline}`,
          ].join(", ")
        : "none";
  }
  node.style.top = style.position === "top" ? `${Math.max(4, (style.marginBottom ?? 70) * scale)}px` : style.position === "middle" ? "50%" : "auto";
  node.style.bottom = style.position === "bottom" ? `${Math.max(4, (style.marginBottom ?? 70) * scale)}px` : "auto";
  node.style.transform = style.position === "middle" ? "translateY(-50%)" : "none";
}

export function updateSubtitleOverlay() {
  if (!overlay) return;
  const style = S.subtitleStyle;
  const line = lineAt(S.playhead);
  if (!style?.enabled || !line) {
    overlay.hidden = true;
    overlay.style.animation = "";
    return;
  }
  const stage = $("#stage");
  const outputHeight = S.project?.output?.height || 1080;
  overlay.hidden = false;
  applyStyle(overlay, style, stage.clientHeight || 240, outputHeight);
  const lineKey = `${line.start.toFixed(2)}`;
  if (overlay.dataset.line !== lineKey) {
    overlay.dataset.line = lineKey;
    overlay.style.animation = "none";
    void overlay.offsetWidth;
    const animation =
      style.animation === "fade" ? "sub-fade 0.28s ease-out" : style.animation === "pop" ? "sub-pop 0.3s ease-out" : style.animation === "slide" ? "sub-slide 0.3s ease-out" : "none";
    overlay.style.animation = animation;
  }
  overlay.innerHTML = "";
  for (const word of line.words) {
    const span = el("span", { text: word.w });
    span.style.marginRight = "0.28em";
    const spoken = S.playhead >= word.e;
    const active = S.playhead >= word.s && S.playhead < word.e;
    if (style.karaoke) {
      span.style.opacity = spoken || active ? "1" : "0.45";
      if (spoken || active) span.style.textShadow = overlay.style.textShadow;
      if (active) span.style.color = style.highlightColor || "#ffb02e";
    }
    overlay.append(span);
  }
}
