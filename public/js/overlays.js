import { S, emit, on, setProject, sourceById } from "./state.js";
import { api, el, openModal, clamp, toast } from "./api.js";
import { findOverlayClip, removeOverlayClip } from "./tracks.js";
import { chipRow, colorField, panel, selectField, slider, toggle } from "./controls.js";
import { MAX_KEYFRAMES, hasKeyframes, keyframeAt, keysFromClip } from "./keyframes.js";
import { overlayAlpha, overlayGeometry } from "./geometry.js";

/**
 * Éditeur d'incrustation : agencements prêts à l'emploi, mouvements prédéfinis
 * (mêmes gabarits que le rendu), images clés, clé chromatique du média, cadrage
 * fin, opacité, rotation, fondus, son.
 * Chaque réglage se voit immédiatement sur l'aperçu.
 */

/** Doit rester aligné avec defaultChroma() côté serveur (src/lib/store.ts). */
const CHROMA_DEFAULTS = { enabled: false, color: "#00ff00", similarity: 0.3, blend: 0.1, despill: true };

/** Source en cours de pipette : l'éditeur se rouvre une fois la couleur choisie. */
let pendingPick = null;

const pct = (value) => `${Math.round(value * 100)}%`;

/** État complet (cadre, rotation, opacité) d'une incrustation à un instant local. */
function stateAt(clip, local) {
  const geometry = overlayGeometry(clip, local, S.motions);
  return {
    box: { x: geometry.x, y: geometry.y, w: geometry.w, h: geometry.h },
    rotation: Number(geometry.rotation) || 0,
    opacity: overlayAlpha(clip, local),
  };
}

export function initOverlayEditor() {
  on("edit-overlay", ({ clipId }) => openOverlayEditor(clipId));

  // Fin de pipette : on applique la couleur au média pointé, puis on rouvre
  // l'éditeur (celui du média touché s'il diffère de celui d'origine).
  on("color-picked", async ({ sourceId, clipId, color }) => {
    const pending = pendingPick;
    pendingPick = null;
    if (!pending) return;
    const applied = await saveChroma(sourceId, { color, enabled: true });
    const target = clipId || pending.clipId;
    if (target && S.project) openOverlayEditor(target);
    if (applied) toast(`Couleur du fond : ${color}`, "ok", 4000);
  });
  on("pick-cancelled", () => {
    const pending = pendingPick;
    pendingPick = null;
    if (pending?.clipId && S.project) openOverlayEditor(pending.clipId);
  });
  on("pick-missed", () => toast("Vise le média d'incrustation (la pipette lit le pixel sous le curseur)", "error", 5000));
}

/** Enregistre la clé chromatique d'un média et rafraîchit l'aperçu. */
export async function saveChroma(sourceId, patch) {
  const current = sourceById(sourceId)?.chroma || CHROMA_DEFAULTS;
  try {
    const data = await api(`/api/projects/${S.project.id}/sources/chroma`, {
      method: "POST",
      body: { sourceId, chroma: { ...current, ...patch } },
    });
    setProject(data.project);
    emit("render");
    return data.chroma;
  } catch (e) {
    toast(`Clé chromatique impossible : ${e.message}`, "error", 7000);
    return null;
  }
}

export function openOverlayEditor(clipId) {
  const found = findOverlayClip(clipId);
  if (!found) return;
  const { layer, clip } = found;
  const source = sourceById(clip.sourceId);
  const placements = S.motions?.placements || [];
  const motions = S.motions?.motions || [{ id: "none", label: "Aucun", icon: "⏹", amount: false }];

  let closeModal = null;
  const reopen = () => {
    closeModal?.();
    openOverlayEditor(clipId);
  };

  const touch = () => {
    emit("render");
    emit("persist");
  };

  const keyframed = hasKeyframes(clip);
  const localNow = () => clamp(S.playhead - clip.start, 0, clip.duration);

  /**
   * Réglages de position/taille/rotation/opacité : ils visent l'image clé
   * courante quand il y en a une, puisque c'est elle que l'aperçu montre à la
   * tête de lecture. Sans image clé à cet instant, on en pose une (sauf si le
   * plafond est atteint : on règle alors la plus proche).
   */
  const stateTarget = () => {
    if (!keyframed) return clip;
    const local = localNow();
    const existing = keyframeAt(clip, local, 0.3);
    if (existing) return existing;
    const keys = clip.keys || [];
    if (keys.length >= MAX_KEYFRAMES) {
      return keys.reduce((best, key) => (!best || Math.abs(key.t - local) < Math.abs(best.t - local) ? key : best), null) || clip;
    }
    const key = { t: Number(local.toFixed(3)), ...stateAt(clip, local) };
    clip.keys = [...keys, key].sort((a, b) => a.t - b.t);
    return key;
  };
  const editBox = (patch) => {
    const holder = keyframed ? stateTarget() : clip;
    holder.box = { ...(holder.box || clip.box), ...patch };
  };
  const editRotation = (value) => {
    const holder = keyframed ? stateTarget() : clip;
    holder.rotation = value;
  };
  const editOpacity = (value) => {
    const holder = keyframed ? stateTarget() : clip;
    holder.opacity = value;
  };
  /** Une image clé a pu être créée par un réglage : la liste doit suivre. */
  const afterEdit = () => {
    if (keyframed) refreshKeys();
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
    value: keyframed ? stateAt(clip, localNow()).opacity : clip.opacity,
    format: (v) => `${Math.round(v * 100)} %`,
    onChange: (v) => {
      editOpacity(v);
      touch();
      afterEdit();
    },
  });
  const rotation = slider("Rotation", {
    min: -180,
    max: 180,
    step: 1,
    value: Math.round(keyframed ? stateAt(clip, localNow()).rotation : clip.rotation || 0),
    unit: "°",
    onChange: (v) => {
      editRotation(v);
      touch();
      afterEdit();
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
  // Pour une incrustation animée, les curseurs montrent l'état interpolé courant.
  const live = keyframed ? stateAt(clip, localNow()) : null;
  const liveBox = live ? live.box : clip.box;
  const boxSlider = (label, key, over = {}) =>
    slider(label, {
      min: -0.2,
      max: 1,
      step: 0.005,
      value: liveBox[key],
      format: pct,
      ...over,
      onChange: (v) => {
        editBox({ [key]: v });
        touch();
        afterEdit();
      },
    });
  const x = boxSlider("Position X", "x");
  const y = boxSlider("Position Y", "y");
  const w = boxSlider("Largeur", "w", { min: 0.02, max: 1.5 });
  const h = boxSlider("Hauteur", "h", { min: 0.02, max: 1.5 });

  /** Reflète sur les curseurs l'état de l'instant courant (tête de lecture). */
  const syncSliders = () => {
    if (!keyframed) return;
    const state = stateAt(clip, localNow());
    for (const [control, value] of [
      [x, state.box.x],
      [y, state.box.y],
      [w, state.box.w],
      [h, state.box.h],
      [rotation, Math.round(state.rotation)],
      [opacity, state.opacity],
    ]) {
      // ne jamais écraser le curseur que l'utilisateur est en train de régler
      if (document.activeElement !== control.input) control.set(value);
    }
  };

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

  // -------------------------------------------------------------------------
  // Images clés
  // -------------------------------------------------------------------------
  const keyList = el("div", { class: "kf-list" });
  const keyInfo = el("div", { class: "muted", style: { fontSize: "11px", marginTop: "4px" } });

  const highlightKeys = () => {
    const local = localNow();
    for (const row of keyList.children) {
      if (!row.dataset.t) continue;
      row.classList.toggle("current", Math.abs(Number(row.dataset.t) - local) <= 0.05);
    }
    keyInfo.textContent = `${(clip.keys || []).length} / ${MAX_KEYFRAMES} images clés · tête de lecture à ${local.toFixed(2)} s dans l'incrustation`;
  };

  const refreshKeys = () => {
    keyList.innerHTML = "";
    const keys = (clip.keys || []).slice().sort((a, b) => a.t - b.t);
    keys.forEach((key, index) => {
      const row = el("div", { class: "kf-row", "data-t": String(key.t) }, [
        el("span", { class: "kf-label", text: `#${index + 1} · ${key.t.toFixed(2)} s` }),
        el("button", {
          class: "ghost small",
          text: "⟶",
          title: "Aller à cette image clé",
          onclick: () => emit("seek", Math.max(0, clip.start + key.t)),
        }),
        el("button", {
          class: "ghost small",
          text: "🗑",
          title: "Supprimer cette image clé",
          onclick: () => {
            if ((clip.keys || []).length <= 1) {
              toast("Garde au moins une image clé — ou désactive les images clés", "error");
              return;
            }
            clip.keys = (clip.keys || []).filter((item) => item !== key);
            touch();
            refreshKeys();
            highlightKeys();
          },
        }),
      ]);
      keyList.append(row);
    });
    if (!keys.length) keyList.append(el("div", { class: "muted", style: { fontSize: "12px" }, text: "Aucune image clé." }));
    highlightKeys();
  };

  const addKey = el("button", {
    text: "📍 Poser une image clé ici",
    title: "Enregistre la position, la taille, la rotation et l'opacité actuelles à la tête de lecture",
    onclick: () => {
      const keys = clip.keys || [];
      const local = localNow();
      const state = stateAt(clip, local);
      const existing = keys.find((key) => Math.abs(key.t - local) < 0.05);
      if (existing) {
        existing.box = state.box;
        existing.rotation = state.rotation;
        existing.opacity = state.opacity;
        toast(`Image clé de ${existing.t.toFixed(2)} s actualisée`, "ok", 3500);
      } else {
        if (keys.length >= MAX_KEYFRAMES) {
          toast(`Maximum ${MAX_KEYFRAMES} images clés par incrustation`, "error", 6000);
          return;
        }
        clip.keys = [...keys, { t: Number(local.toFixed(3)), ...state }].sort((a, b) => a.t - b.t);
        toast(`Image clé posée à ${local.toFixed(2)} s`, "ok", 3500);
      }
      touch();
      refreshKeys();
      highlightKeys();
    },
  });

  const keyToggle = keyframed
    ? el("div", { class: "panel-actions" }, [
        el("button", {
          text: "✖ Désactiver les images clés",
          title: "La position, la taille, la rotation et l'opacité actuelles restent : elles deviennent fixes",
          onclick: () => {
            const state = stateAt(clip, localNow());
            clip.box = state.box;
            clip.rotation = state.rotation;
            clip.opacity = state.opacity;
            delete clip.keys;
            delete clip.ease;
            touch();
            reopen();
          },
        }),
      ])
    : el("div", { class: "panel-actions" }, [
        el("button", {
          class: "primary",
          text: "✨ Activer les images clés",
          title: "Deux états (début et fin) à régler au glisser sur l'aperçu",
          onclick: () => {
            clip.keys = keysFromClip(clip);
            // « doux » par défaut : un premier mouvement linéaire paraît raide
            clip.ease = "smooth";
            touch();
            reopen();
          },
        }),
      ]);

  const ease = selectField(
    "Courbe entre les images clés",
    [
      { value: "smooth", label: "Doux (départ et arrivée progressifs)" },
      { value: "linear", label: "Linéaire (vitesse constante)" },
    ],
    clip.ease === "linear" ? "linear" : "smooth",
    (value) => {
      clip.ease = value;
      touch();
    }
  );

  const keySection = el("div", {}, keyframed
    ? [
        el("div", { class: "muted", style: { fontSize: "11px", marginBottom: "6px" }, text: "Glisse l'incrustation sur l'aperçu pour régler l'image clé courante, ou poses-en une ici. Au glisser sans image clé à cet instant, une nouvelle est créée. Les poignées changent la taille et l'angle." }),
        keyList,
        keyInfo,
        el("div", { class: "ctrl-row", style: { marginTop: "6px" } }, [addKey]),
        ease.node,
        keyToggle,
      ]
    : [
        el("div", { class: "muted", style: { fontSize: "11px", marginBottom: "6px" }, text: "Deux états (début et fin) interpolés : position, taille, rotation et opacité. Le rendu et l'aperçu évaluent exactement les mêmes formules." }),
        keyToggle,
      ]);

  const motionSection = el("div", {}, [
    panel("Mouvement"),
    chipRow(motions, clip.motion?.preset || "none", (id) => {
      clip.motion = { preset: id, amount: clip.motion?.amount ?? 0.5 };
      amount.node.hidden = !motions.find((m) => m.id === id)?.amount;
      touch();
    }),
    amount.node,
  ]);
  // Le rendu ignore les mouvements prédéfinis dès qu'il y a des images clés.
  if (keyframed) motionSection.hidden = true;

  // -------------------------------------------------------------------------
  // Clé chromatique (vert / bleu) — par média, donc valable partout où il sert
  // -------------------------------------------------------------------------
  let chromaSection = null;
  if (source && source.kind !== "audio") {
    const chroma = { ...CHROMA_DEFAULTS, ...(source.chroma || {}) };
    const enabled = toggle("Détourer ce fond", chroma.enabled, (value) => {
      push({ enabled: value });
      synchronize();
    }, "S'applique au média partout où il est incrusté");
    const color = colorField("Couleur du fond", chroma.color, (value) => push({ color: value, enabled: true }));
    const similarity = slider("Similarité", {
      min: 0,
      max: 1,
      step: 0.01,
      value: chroma.similarity,
      format: (v) => `${Math.round(v * 100)} %`,
      hint: "Largeur de la plage de couleurs rendue transparente",
      onChange: (v) => push({ similarity: v }),
    });
    const blend = slider("Mélange", {
      min: 0,
      max: 1,
      step: 0.01,
      value: chroma.blend,
      format: (v) => `${Math.round(v * 100)} %`,
      hint: "Adoucit le bord : 0 = contour net",
      onChange: (v) => push({ blend: v }),
    });
    const despill = toggle("Retirer le reflet de l'écran", chroma.despill !== false, (value) => push({ despill: value }),
      "Supprime la teinte verte (ou bleue) qui reste sur les contours");
    const pipette = el("button", {
      text: "💧 Pipette sur l'aperçu",
      title: "Clique le fond sur l'aperçu : l'éditeur se rouvre tout seul",
      onclick: () => {
        pendingPick = { clipId: clip.id, sourceId: source.id };
        closeModal?.();
        emit("pick-color", { sourceId: source.id, clipId: clip.id });
        toast("Clique la couleur du fond sur l'aperçu (Échap pour annuler)", "info", 7000);
      },
    });
    const swatches = chipRow(
      [
        { id: "#00ff00", label: "Fond vert", icon: "🟩" },
        { id: "#0000ff", label: "Fond bleu", icon: "🟦" },
      ],
      chroma.color.toLowerCase(),
      (id) => {
        color.input.value = id;
        push({ color: id, enabled: true });
        synchronize();
      }
    );

    let timer = null;
    const pendingPatch = {};
    /** Envoi groupé : un glissement de curseur = une seule sauvegarde. */
    const push = (patch) => {
      Object.assign(pendingPatch, patch);
      synchronize();
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const payload = { ...pendingPatch };
        for (const key of Object.keys(pendingPatch)) delete pendingPatch[key];
        await saveChroma(source.id, payload);
      }, 220);
    };
    const synchronize = () => {
      const on = enabled.value();
      for (const control of [color.node, similarity.node, blend.node, despill.node]) {
        control.style.opacity = on ? "1" : "0.45";
        control.querySelector("input")?.toggleAttribute("disabled", !on);
      }
      pipette.hidden = !on;
      swatches.hidden = !on;
    };
    synchronize();

    chromaSection = el("div", {}, [
      el("div", { class: "muted", style: { fontSize: "11px", marginBottom: "6px" }, text: "Fond vert ou bleu : le média est détouré avec les mêmes formules que l'export (colorkey + despill)." }),
      enabled.node,
      el("div", { class: "ctrl-row" }, [pipette, swatches]),
      color.node,
      el("div", { class: "ctrl-grid-2" }, [similarity.node, blend.node]),
      despill.node,
    ]);
  }

  // Reflète sur les curseurs ce qui est réglé au glisser sur l'aperçu.
  const stopTouch = on("overlay-touched", ({ clipId: id }) => {
    if (!keyList.isConnected) {
      stopTouch();
      return;
    }
    if (id !== clip.id) return;
    refreshKeys();
    syncSliders();
  });
  const stopTick = on("tick", () => {
    if (!keyList.isConnected) {
      stopTick();
      return;
    }
    highlightKeys();
    syncSliders();
  });

  openModal((close) => {
    closeModal = close;
    if (keyframed) refreshKeys();
    const modal = el("div", { class: "modal-editor" }, [
      el("h2", { text: `🎞️ Incrustation — ${source?.name || "média"}` }),
      el("div", {
        class: "muted",
        style: { fontSize: "12px", marginBottom: "8px" },
        text: `Calque « ${layer.name} » · le cadre est en fractions du cadre final : ce que tu vois sur l'aperçu est ce qui sera exporté.`,
      }),

      panel("Images clés"),
      keySection,

      ...(chromaSection ? [panel("Clé chromatique (fond vert ou bleu)"), chromaSection] : []),

      panel("Agencement"),
      chipRow(placements, null, (id) => {
        const placement = placements.find((p) => p.id === id);
        if (!placement) return;
        if (keyframed) {
          // l'agencement s'applique à l'image clé courante (le mouvement
          // prédéfini est ignoré dès qu'il y a des images clés)
          const holder = stateTarget();
          holder.box = { ...placement.box };
        } else {
          clip.box = { ...placement.box };
          clip.motion = { preset: placement.motion, amount: clip.motion?.amount ?? 0.5 };
        }
        x.set(placement.box.x);
        y.set(placement.box.y);
        w.set(placement.box.w);
        h.set(placement.box.h);
        touch();
        afterEdit();
      }),

      motionSection,

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
