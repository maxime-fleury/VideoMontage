import { S, emit, on } from "./state.js";
import { el, openModal, clamp } from "./api.js";
import { addText, removeText, textById } from "./tracks.js";
import { chipRow, colorField, field, panel, selectField, slider, toggle } from "./controls.js";

/**
 * Textes libres : aucun lien avec la voix. Style complet, animations d'entrée et
 * de sortie, position réglable ici ou directement à la souris sur l'aperçu.
 */

const ANIM_IN = [
  { id: "none", label: "Aucune" },
  { id: "fade", label: "Fondu" },
  { id: "pop", label: "Pop", hint: "Apparition en grossissant" },
  { id: "slide-up", label: "Monte" },
  { id: "slide-down", label: "Descend" },
  { id: "slide-left", label: "Vient de droite" },
  { id: "slide-right", label: "Vient de gauche" },
  { id: "typewriter", label: "Machine à écrire" },
  { id: "word-highlight", label: "Mot par mot", hint: "Surligne les mots les uns après les autres" },
];

const ANIM_OUT = [
  { id: "none", label: "Aucune" },
  { id: "fade", label: "Fondu" },
  { id: "pop", label: "Pop" },
  { id: "slide", label: "Glisse" },
];

export function initTexts() {
  on("edit-text", ({ id }) => openTextEditor(id));
}

/** Ajoute un texte et ouvre directement son éditeur. */
export function addTextAtPlayhead() {
  const text = addText({ start: S.playhead });
  if (!text) return null;
  // Se placer juste après le début : l'animation d'entrée est finie, le texte est
  // donc visible tout de suite et peut être déplacé à la souris.
  emit("seek", Math.min(text.start + 0.6, text.start + text.duration / 2));
  openTextEditor(text.id);
  return text;
}

export function openTextEditor(id) {
  const text = textById(id);
  if (!text) return;
  const fonts = (S.fonts || ["Outfit"]).slice();
  const touch = () => {
    emit("render");
    emit("persist");
  };

  const content = field("Texte", text.text, (value) => {
    text.text = value;
    touch();
  }, { rows: 3, hint: "Entrée = nouvelle ligne" });

  const font = selectField("Police", fonts.map((name) => ({ value: name, label: name })), text.style.font, (value) => {
    text.style.font = value;
    touch();
  }, "Polices installées localement (data/fonts/ttf)");

  const size = slider("Taille", {
    min: 0.02,
    max: 0.3,
    step: 0.002,
    value: text.style.size,
    format: (v) => `${Math.round(v * 100)} % de la hauteur`,
    onChange: (v) => {
      text.style.size = v;
      touch();
    },
  });
  const bold = toggle("Gras", text.style.bold, (value) => {
    text.style.bold = value;
    touch();
  });
  const italic = toggle("Italique", text.style.italic, (value) => {
    text.style.italic = value;
    touch();
  });
  const uppercase = toggle("Majuscules", text.style.uppercase, (value) => {
    text.style.uppercase = value;
    touch();
  });

  const color = colorField("Couleur", text.style.color, (value) => {
    text.style.color = value;
    touch();
  });
  const highlight = colorField("Surlignage", text.style.highlightColor, (value) => {
    text.style.highlightColor = value;
    touch();
  });
  const outlineColor = colorField("Contour", text.style.outlineColor, (value) => {
    text.style.outlineColor = value;
    touch();
  });
  const outlineWidth = slider("Épaisseur du contour", {
    min: 0,
    max: 20,
    step: 1,
    value: text.style.outlineWidth,
    unit: " px",
    onChange: (v) => {
      text.style.outlineWidth = v;
      touch();
    },
  });
  const shadow = slider("Ombre portée", {
    min: 0,
    max: 40,
    step: 1,
    value: text.style.shadow,
    unit: " px",
    onChange: (v) => {
      text.style.shadow = v;
      touch();
    },
  });
  const background = toggle("Pastille de fond", !!text.style.background, (value) => {
    text.style.background = value ? text.style.background || "#12081f" : "";
    touch();
  });
  const backgroundColor = colorField("Couleur du fond", text.style.background || "#12081f", (value) => {
    text.style.background = value;
    background.input.checked = true;
    touch();
  });
  const padding = slider("Marge intérieure", {
    min: 0,
    max: 60,
    step: 1,
    value: text.style.padding,
    unit: " px",
    onChange: (v) => {
      text.style.padding = v;
      touch();
    },
  });
  const spacing = slider("Interlettrage", {
    min: -5,
    max: 20,
    step: 0.5,
    value: text.style.letterSpacing,
    unit: " px",
    onChange: (v) => {
      text.style.letterSpacing = v;
      touch();
    },
  });
  const lineHeight = slider("Interligne", {
    min: 0.8,
    max: 2.2,
    step: 0.05,
    value: text.style.lineHeight,
    unit: "",
    onChange: (v) => {
      text.style.lineHeight = v;
      touch();
    },
  });
  const rotation = slider("Rotation", {
    min: -180,
    max: 180,
    step: 1,
    value: Math.round(text.rotation || 0),
    unit: "°",
    onChange: (v) => {
      text.rotation = v;
      touch();
    },
  });
  const start = slider("Début", {
    min: 0,
    max: Math.max(10, Math.round((S.build?.duration || 60) * 10) / 10),
    step: 0.1,
    value: Number(text.start.toFixed(1)),
    unit: " s",
    onChange: (v) => {
      text.start = v;
      touch();
    },
  });
  const duration = slider("Durée", {
    min: 0.3,
    max: 60,
    step: 0.1,
    value: Number(text.duration.toFixed(1)),
    unit: " s",
    onChange: (v) => {
      text.duration = v;
      touch();
    },
  });
  const animDuration = slider("Durée de l'animation", {
    min: 0.05,
    max: 2,
    step: 0.05,
    value: text.animation.duration,
    unit: " s",
    onChange: (v) => {
      text.animation.duration = v;
      touch();
    },
  });
  const width = slider("Largeur du bloc", {
    min: 0.1,
    max: 1.6,
    step: 0.01,
    value: text.box.w,
    format: (v) => `${Math.round(v * 100)} %`,
    onChange: (v) => {
      text.box.w = v;
      touch();
    },
  });
  const posX = slider("Position X", {
    min: -0.3,
    max: 1.2,
    step: 0.005,
    value: text.box.x,
    format: (v) => `${Math.round(v * 100)} %`,
    onChange: (v) => {
      text.box.x = v;
      touch();
    },
  });
  const posY = slider("Position Y", {
    min: -0.3,
    max: 1.2,
    step: 0.005,
    value: text.box.y,
    format: (v) => `${Math.round(v * 100)} %`,
    onChange: (v) => {
      text.box.y = v;
      touch();
    },
  });

  const animIn = chipRow(ANIM_IN, text.animation.in, (id) => {
    text.animation.in = id;
    touch();
  });
  const animOut = chipRow(ANIM_OUT, text.animation.out, (id) => {
    text.animation.out = id;
    touch();
  });
  const align = chipRow(
    [
      { id: "left", label: "Gauche" },
      { id: "center", label: "Centré" },
      { id: "right", label: "Droite" },
    ],
    text.style.align,
    (id) => {
      text.style.align = id;
      touch();
    }
  );

  openModal((close) => {
    const modal = el("div", { class: "modal-editor" }, [
      el("h2", { text: "📝 Texte libre" }),
      el("div", {
        class: "muted",
        style: { fontSize: "12px", marginBottom: "8px" },
        text: "Indépendant de la voix. Déplace-le et redimensionne-le directement à la souris sur l'aperçu (les poignées apparaissent sur le texte sélectionné).",
      }),

      content.node,
      panel("Style"),
      el("div", { class: "ctrl-grid-2" }, [font.node, size.node]),
      el("div", { class: "ctrl-row" }, [bold.node, italic.node, uppercase.node]),
      el("div", { class: "ctrl-row" }, [color.node, highlight.node, outlineColor.node]),
      el("div", { class: "ctrl-grid-2" }, [outlineWidth.node, shadow.node]),
      el("div", { class: "ctrl-row" }, [background.node, backgroundColor.node]),
      el("div", { class: "ctrl-grid-2" }, [padding.node, spacing.node]),
      el("div", { class: "ctrl-grid-2" }, [lineHeight.node, width.node]),

      panel("Animation"),
      el("div", { class: "ctrl-label", text: "Entrée" }),
      animIn,
      el("div", { class: "ctrl-label", text: "Sortie" }),
      animOut,
      animDuration.node,

      panel("Position"),
      el("div", { class: "ctrl-label", text: "Alignement" }),
      align,
      el("div", { class: "ctrl-grid-2" }, [posX.node, posY.node, rotation.node]),

      panel("Timing"),
      start.node,
      duration.node,

      el("div", { class: "footer" }, [
        el("button", {
          class: "danger",
          text: "🗑 Supprimer",
          onclick: () => {
            removeText(text.id, { ask: true });
            close();
          },
        }),
        el("button", {
          text: "🎯 Aller au texte",
          onclick: () => emit("seek", Math.max(0, text.start)),
        }),
        el("button", {
          text: "⧉ Dupliquer",
          onclick: () => {
            const copy = JSON.parse(JSON.stringify(text));
            copy.id = `txt_${Math.random().toString(36).slice(2, 9)}`;
            copy.start = clamp(text.start + text.duration + 0.2, 0, Math.max(0, (S.build?.duration || 60) - 0.5));
            copy.createdAt = Date.now();
            S.project.texts.push(copy);
            close();
            emit("render");
            emit("persist");
          },
        }),
        el("button", { class: "primary", text: "Terminé", onclick: () => close() }),
      ]),
    ]);
    return modal;
  });
}
