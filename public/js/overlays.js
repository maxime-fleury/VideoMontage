import { S, emit, on, sourceById } from "./state.js";
import { el, openModal, clamp } from "./api.js";
import { findOverlayClip, removeOverlayClip } from "./tracks.js";
import { chipRow, colorField, panel, selectField, slider, toggle } from "./controls.js";

/**
 * Éditeur d'incrustation : agencements prêts à l'emploi, mouvements prédéfinis
 * (mêmes gabarits que le rendu), cadrage fin, opacité, rotation, fondus, son.
 * Chaque réglage se voit immédiatement sur l'aperçu.
 */

const pct = (value) => `${Math.round(value * 100)}%`;

export function initOverlayEditor() {
  on("edit-overlay", ({ clipId }) => openOverlayEditor(clipId));
}

export function openOverlayEditor(clipId) {
  const found = findOverlayClip(clipId);
  if (!found) return;
  const { layer, clip } = found;
  const source = sourceById(clip.sourceId);
  const placements = S.motions?.placements || [];
  const motions = S.motions?.motions || [{ id: "none", label: "Aucun", icon: "⏹", amount: false }];

  const touch = () => {
    emit("render");
    emit("persist");
  };

  const start = slider("Début", {
    min: 0,
    max: Math.max(10, Math.round((S.build?.duration || 60) * 10) / 10),
    step: 0.1,
    value: Number(clip.start.toFixed(1)),
    unit: " s",
    onChange: (v) => {
      clip.start = v;
      touch();
    },
  });
  const duration = slider("Durée", {
    min: 0.2,
    max: Math.max(2, Math.min(120, Math.round(((source?.duration || 30) + 1) * 10) / 10)),
    step: 0.1,
    value: Number(clip.duration.toFixed(1)),
    unit: " s",
    onChange: (v) => {
      clip.duration = v;
      touch();
    },
  });
  const opacity = slider("Opacité", {
    min: 0,
    max: 1,
    step: 0.01,
    value: clip.opacity,
    format: (v) => `${Math.round(v * 100)} %`,
    onChange: (v) => {
      clip.opacity = v;
      touch();
    },
  });
  const rotation = slider("Rotation", {
    min: -180,
    max: 180,
    step: 1,
    value: Math.round(clip.rotation || 0),
    unit: "°",
    onChange: (v) => {
      clip.rotation = v;
      touch();
    },
  });
  const fadeIn = slider("Fondu d'entrée", {
    min: 0,
    max: 3,
    step: 0.05,
    value: clip.fadeIn || 0,
    unit: " s",
    onChange: (v) => {
      clip.fadeIn = v;
      touch();
    },
  });
  const fadeOut = slider("Fondu de sortie", {
    min: 0,
    max: 3,
    step: 0.05,
    value: clip.fadeOut || 0,
    unit: " s",
    onChange: (v) => {
      clip.fadeOut = v;
      touch();
    },
  });
  const x = slider("Position X", { min: -0.2, max: 1, step: 0.005, value: clip.box.x, format: pct, onChange: (v) => { clip.box.x = v; touch(); } });
  const y = slider("Position Y", { min: -0.2, max: 1, step: 0.005, value: clip.box.y, format: pct, onChange: (v) => { clip.box.y = v; touch(); } });
  const w = slider("Largeur", { min: 0.05, max: 1.5, step: 0.005, value: clip.box.w, format: pct, onChange: (v) => { clip.box.w = v; touch(); } });
  const h = slider("Hauteur", { min: 0.05, max: 1.5, step: 0.005, value: clip.box.h, format: pct, onChange: (v) => { clip.box.h = v; touch(); } });

  const amount = slider("Intensité du mouvement", {
    min: 0,
    max: 1,
    step: 0.02,
    value: clip.motion?.amount ?? 0.5,
    format: (v) => `${Math.round(v * 100)} %`,
    onChange: (v) => {
      clip.motion = { ...(clip.motion || { preset: "none" }), amount: v };
      touch();
    },
  });
  amount.node.hidden = !motions.find((m) => m.id === clip.motion?.preset)?.amount;

  const fit = selectField(
    "Cadrage du média",
    [
      { value: "cover", label: "Remplir (recadre)" },
      { value: "contain", label: "Entier (marges transparentes)" },
    ],
    clip.fit || "cover",
    (value) => {
      clip.fit = value;
      touch();
    },
    "Une image avec transparence (logo, PNG) sera mieux en « Entier »"
  );

  const audioToggle = source?.kind === "video"
    ? toggle("Garder le son de la vidéo", clip.audio?.mute === false, (value) => {
        clip.audio = { ...(clip.audio || { gain: 1 }), mute: !value };
        touch();
      })
    : null;
  const audioGain = source?.kind === "video"
    ? slider("Volume de la vidéo", {
        min: 0,
        max: 2,
        step: 0.05,
        value: clip.audio?.gain ?? 1,
        format: (v) => `${Math.round(20 * Math.log10(Math.max(0.01, v)))} dB`,
        onChange: (v) => {
          clip.audio = { ...(clip.audio || { mute: false }), gain: v };
          touch();
        },
      })
    : null;

  openModal((close) => {
    const modal = el("div", { class: "modal-editor" }, [
      el("h2", { text: `🎞️ Incrustation — ${source?.name || "média"}` }),
      el("div", {
        class: "muted",
        style: { fontSize: "12px", marginBottom: "8px" },
        text: `Calque « ${layer.name} » · le cadre est en fractions du cadre final : ce que tu vois sur l'aperçu est ce qui sera exporté.`,
      }),

      panel("Agencement"),
      chipRow(placements, null, (id) => {
        const placement = placements.find((p) => p.id === id);
        if (!placement) return;
        clip.box = { ...placement.box };
        clip.motion = { preset: placement.motion, amount: clip.motion?.amount ?? 0.5 };
        x.set(clip.box.x);
        y.set(clip.box.y);
        w.set(clip.box.w);
        h.set(clip.box.h);
        touch();
      }),

      panel("Mouvement"),
      chipRow(motions, clip.motion?.preset || "none", (id) => {
        clip.motion = { preset: id, amount: clip.motion?.amount ?? 0.5 };
        amount.node.hidden = !motions.find((m) => m.id === id)?.amount;
        touch();
      }),
      amount.node,

      panel("Cadrage fin"),
      el("div", { class: "ctrl-grid-2" }, [x.node, y.node, w.node, h.node]),
      fit.node,
      opacity.node,
      rotation.node,
      fadeIn.node,
      fadeOut.node,

      panel("Timing"),
      start.node,
      duration.node,

      ...(audioToggle ? [panel("Son de la vidéo"), audioToggle.node, audioGain.node] : []),

      el("div", { class: "footer" }, [
        el("button", {
          class: "danger",
          text: "🗑 Supprimer",
          onclick: () => {
            removeOverlayClip(layer.id, clip.id, { ask: true });
            close();
          },
        }),
        el("button", {
          text: "🎯 Aller à l'incrustation",
          onclick: () => emit("seek", Math.max(0, clip.start)),
        }),
        el("button", { class: "primary", text: "Terminé", onclick: () => close() }),
      ]),
    ]);
    return modal;
  });
}
