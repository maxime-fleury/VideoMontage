import { S, emit, on, duration, clips, sourceById, allAudioClips, adoptProject } from "./state.js";
import { $, el, api, toast, clamp, fmtBytes, fmtTime, fmtDuration, watchJob } from "./api.js";
import { openImageEditor, openIllustrationPicker } from "./illustrations.js";

export function initPanels() {
  on("project", renderSidePanel);
  on("selection-clip", renderSidePanel);
  on("search", renderSidePanel);
  on("word", () => {
    if (S.activeWord) {
      S.search.query = S.activeWord.word;
      searchImages(S.activeWord.word);
    }
    renderSidePanel();
  });
}

export async function searchImages(query, provider) {
  if (!query) return;
  S.search.query = query;
  S.search.provider = provider || S.search.provider;
  S.search.loading = true;
  S.search.errors = [];
  emit("search");
  try {
    const data = await api(`/api/projects/${S.project.id}/search`, {
      method: "POST",
      body: { query, provider: S.search.provider, count: 18 },
    });
    S.search.results = data.results || [];
    S.search.errors = data.errors || [];
    if (!S.search.results.length) toast(`Aucune illustration trouvée pour « ${query} »`, "error");
  } catch (e) {
    S.search.errors = [e.message];
    S.search.results = [];
    toast(`Recherche impossible : ${e.message}`, "error");
  } finally {
    S.search.loading = false;
    emit("search");
  }
}

async function addResult(result) {
  if (!S.project) return;
  const start = S.activeWord?.start ?? S.playhead;
  const covering = clips().find((c) => start >= c.start - 0.05 && start <= c.start + c.duration + 0.05);
  let clipDuration = 3;
  if (covering) clipDuration = covering.duration;
  const next = clips()
    .filter((c) => c.start > start + 0.2)
    .sort((a, b) => a.start - b.start)[0];
  if (!covering && next) clipDuration = clamp(next.start - start, 0.6, 8);
  try {
    const data = await api(`/api/projects/${S.project.id}/add-image`, {
      method: "POST",
      body: {
        url: result.url,
        referer: result.pageUrl,
        keyword: S.search.query,
        provider: result.provider,
        start,
        duration: clipDuration,
      },
    });
    let project = data.project;
    if (covering && covering.id !== data.clip.id) {
      project = {
        ...project,
        videoTrack: project.videoTrack.filter((c) => c.id !== covering.id),
      };
      const res = await api(`/api/projects/${S.project.id}/update`, {
        method: "POST",
        body: { videoTrack: project.videoTrack },
      });
      project = res.project;
      toast(`Clip remplacé à ${fmtTime(start)}`, "ok");
    } else {
      toast(`« ${S.search.query} » ajouté à ${fmtTime(start)}`, "ok");
    }
    adoptProject(project);
    emit("project-external", project);
  } catch (e) {
    toast(`Ajout impossible : ${e.message}`, "error");
  }
}

async function addByUrl(url) {
  if (!url) return;
  await addResult({ url, provider: "url", pageUrl: undefined });
}

// ---------------------------------------------------------------------------
// Rendu du panneau
// ---------------------------------------------------------------------------

export function renderSidePanel() {
  const host = $("#sidePanel");
  if (!host) return;
  host.innerHTML = "";
  if (!S.project) {
    host.append(el("div", { class: "muted", text: "Crée un projet pour commencer." }));
    return;
  }

  if (S.selectedClipId) {
    host.append(renderClipProperties());
    return;
  }

  host.append(renderSearchPanel(), el("div", { class: "divider" }), renderVoiceInfo(), el("div", { class: "divider" }), renderSetupInfo());
}

function renderSearchPanel() {
  const box = el("div");
  box.append(el("div", { class: "panel-title", text: "🔍 Illustrations" }));
  if (S.activeWord) {
    box.append(
      el("div", {
        class: "muted",
        style: { margin: "4px 0 8px", fontSize: "12px" },
        html: `Mot choisi : <b style="color:var(--accent)">${S.activeWord.word}</b> à ${fmtTime(S.activeWord.start)}`,
      })
    );
  } else {
    box.append(
      el("div", {
        class: "muted",
        style: { margin: "4px 0 8px", fontSize: "12px" },
        text: "Clique un mot dans la transcription, ou cherche directement.",
      })
    );
  }

  const input = el("input", { type: "text", value: S.search.query || "", placeholder: "ex: château, forêt, épée…" });
  const providers = [
    ["web", "Web (images)"],
    ["openverse", "Openverse (CC)"],
    ["wikimedia", "Wikimedia"],
  ];
  const provider = el("select", { title: "Source" }, providers.map(([value, text]) => el("option", { value, text })));
  // valeur mémorisée d'une ancienne version → repli sur « web »
  provider.value = providers.some(([value]) => value === S.search.provider) ? S.search.provider : "web";
  S.search.provider = provider.value;
  provider.addEventListener("change", () => {
    S.search.provider = provider.value;
    if (S.search.query) searchImages(S.search.query, provider.value);
  });
  const form = el("form", { class: "search-form" }, [
    input,
    el("button", { class: "primary", type: "submit", text: S.search.loading ? "…" : "Chercher" }),
  ]);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    searchImages(input.value.trim(), provider.value);
  });
  box.append(form, el("div", { class: "opt", style: { marginBottom: "8px" } }, [provider]));

  if (S.search.loading) box.append(el("div", { class: "muted", html: '<span class="spinner"></span> Recherche…' }));

  if (S.search.results.length) {
    const grid = el("div", { class: "results-grid" });
    for (const result of S.search.results) {
      const thumb = `/api/imgproxy?url=${encodeURIComponent(result.thumb)}${result.pageUrl ? `&referer=${encodeURIComponent(result.pageUrl)}` : ""}`;
      const item = el("div", { class: "result", title: `${result.title}\n${result.license || result.provider}` });
      item.append(el("img", { src: thumb, loading: "lazy", alt: result.title || "" }));
      item.append(
        el("button", {
          class: "add",
          text: "+",
          title: "Ajouter à la timeline",
          onclick: (e) => {
            e.stopPropagation();
            addResult(result);
          },
        })
      );
      item.append(el("div", { class: "badge", text: result.license || result.provider }));
      item.addEventListener("click", () => addResult(result));
      grid.append(item);
    }
    box.append(grid);
    box.append(
      el("div", {
        class: "muted",
        style: { marginTop: "8px", fontSize: "11px" },
        text: "Clic sur une image = ajout (ou remplacement du clip au même endroit).",
      })
    );
  } else if (S.search.errors.length) {
    box.append(el("div", { class: "muted", style: { fontSize: "11px" }, text: S.search.errors.join(" · ") }));
  }

  const urlInput = el("input", { type: "text", placeholder: "…ou colle une URL d'image" });
  const urlForm = el("form", { class: "search-form", style: { marginTop: "8px" } }, [
    urlInput,
    el("button", { type: "submit", text: "Ajouter" }),
  ]);
  urlForm.addEventListener("submit", (e) => {
    e.preventDefault();
    addByUrl(urlInput.value.trim());
    urlInput.value = "";
  });
  box.append(urlForm);
  return box;
}

function propRow(label, input, valueText) {
  const row = el("div", { class: "prop-row" }, [el("span", { text: label }), input, valueText ? el("span", { class: "val", text: valueText }) : null]);
  return row;
}

function renderClipProperties() {
  const box = el("div");
  const isAudio = S.selectedClipKind === "audio";
  const entry = isAudio
    ? allAudioClips().find((e) => e.clip.id === S.selectedClipId)
    : { clip: clips().find((c) => c.id === S.selectedClipId) };

  if (!entry || !entry.clip) {
    S.selectedClipId = null;
    return renderSearchPanel();
  }
  const clip = entry.clip;
  const source = sourceById(clip.sourceId);
  const track = entry.track;

  box.append(
    el("div", { class: "panel-head" }, [
      el("div", { class: "panel-title", text: isAudio ? "🎵 Clip audio" : "🖼️ Clip vidéo" }),
      el("button", { class: "ghost", text: "← Retour", onclick: () => { S.selectedClipId = null; emit("selection-clip", {}); } }),
    ])
  );
  box.append(el("div", { class: "muted", style: { fontSize: "12px", marginBottom: "8px" }, text: source?.name || "source manquante" }));
  if (track) box.append(el("div", { class: "kv" }, [el("span", { text: "Piste" }), el("b", { text: track.name })]));

  if (!isAudio && clip.keyword) box.append(el("div", { class: "kv" }, [el("span", { text: "Mot-clé" }), el("b", { text: clip.keyword })]));

  // position
  const startInput = el("input", { type: "number", step: "0.1", value: clip.start.toFixed(2), style: { width: "80px" } });
  startInput.addEventListener("change", () => {
    clip.start = Math.max(0, Number(startInput.value) || 0);
    emit("persist");
    renderSidePanel();
  });
  box.append(el("div", { class: "prop-row" }, [el("span", { text: "Début (s)" }), startInput]));

  const durInput = el("input", { type: "number", step: "0.1", value: clip.duration.toFixed(2), style: { width: "80px" } });
  durInput.addEventListener("change", () => {
    clip.duration = Math.max(0.2, Number(durInput.value) || 1);
    emit("persist");
    renderSidePanel();
  });
  box.append(el("div", { class: "prop-row" }, [el("span", { text: "Durée (s)" }), durInput]));

  if (!isAudio) {
    const offsetInput = el("input", { type: "number", step: "0.1", value: (clip.offset || 0).toFixed(2), style: { width: "80px" } });
    offsetInput.addEventListener("change", () => {
      clip.offset = Math.max(0, Number(offsetInput.value) || 0);
      emit("persist");
    });
    box.append(el("div", { class: "prop-row" }, [el("span", { text: "Décalage source (s)" }), offsetInput]));

    const fadeIn = el("input", { type: "range", min: "0", max: "2", step: "0.05", value: clip.effect.fadeIn });
    fadeIn.addEventListener("input", () => {
      clip.effect.fadeIn = Number(fadeIn.value);
      fadeIn.nextSibling.textContent = `${clip.effect.fadeIn.toFixed(2)} s`;
      emit("persist");
      emit("dragging");
    });
    box.append(propRow("Fondu entrée", fadeIn, `${clip.effect.fadeIn.toFixed(2)} s`));

    const fadeOut = el("input", { type: "range", min: "0", max: "2", step: "0.05", value: clip.effect.fadeOut });
    fadeOut.addEventListener("input", () => {
      clip.effect.fadeOut = Number(fadeOut.value);
      fadeOut.nextSibling.textContent = `${clip.effect.fadeOut.toFixed(2)} s`;
      emit("persist");
      emit("dragging");
    });
    box.append(propRow("Fondu sortie (noir)", fadeOut, `${clip.effect.fadeOut.toFixed(2)} s`));

    const kb = el("input", { type: "checkbox", checked: clip.effect.kenBurns });
    kb.addEventListener("change", () => {
      clip.effect.kenBurns = kb.checked;
      emit("persist");
    });
    box.append(el("div", { class: "prop-row" }, [el("span", { text: "Zoom lent (Ken Burns)" }), kb]));

    if (clip.effect.kenBurns) {
      const zoomTo = el("input", { type: "range", min: "1.02", max: "1.4", step: "0.01", value: clip.effect.zoomTo || 1.1 });
      zoomTo.addEventListener("input", () => {
        clip.effect.zoomTo = Number(zoomTo.value);
        zoomTo.nextSibling.textContent = `×${clip.effect.zoomTo.toFixed(2)}`;
        emit("persist");
      });
      box.append(propRow("Zoom final", zoomTo, `×${(clip.effect.zoomTo || 1.1).toFixed(2)}`));
    }

    box.append(el("div", { class: "divider" }));
    box.append(el("div", { class: "panel-title", text: "Transition d'entrée" }));
    const transitionTypes = [
      ["cut", "Coupe franche"],
      ["fade-black", "Fondu au noir"],
      ["dissolve", "Fondu enchaîné"],
      ["slide-right", "Glissement (depuis la droite)"],
      ["slide-left", "Glissement (depuis la gauche)"],
      ["slide-up", "Glissement (depuis le bas)"],
      ["slide-down", "Glissement (depuis le haut)"],
      ["zoom-in", "Zoom avant"],
    ];
    const transition = el("select", {}, transitionTypes.map(([value, label]) => el("option", { value, text: label })));
    transition.value = clip.effect.transition?.type || "cut";
    transition.addEventListener("change", () => {
      clip.effect.transition = { ...(clip.effect.transition || { duration: 0.6 }), type: transition.value };
      if (!clip.effect.transition.duration) clip.effect.transition.duration = 0.6;
      emit("persist");
      renderSidePanel();
    });
    box.append(el("div", { class: "prop-row" }, [el("span", { text: "Type" }), transition]));
    if ((clip.effect.transition?.type || "cut") !== "cut") {
      const td = el("input", { type: "range", min: "0.15", max: "2", step: "0.05", value: String(clip.effect.transition?.duration ?? 0.6) });
      const tdVal = el("span", { class: "val", text: `${(clip.effect.transition?.duration ?? 0.6).toFixed(2)} s` });
      td.addEventListener("input", () => {
        clip.effect.transition = { ...(clip.effect.transition || { type: "dissolve" }), duration: Number(td.value) };
        tdVal.textContent = `${Number(td.value).toFixed(2)} s`;
        emit("persist");
      });
      box.append(el("div", { class: "prop-row" }, [el("span", { text: "Durée" }), td, tdVal]));
      box.append(
        el("div", {
          class: "muted",
          style: { fontSize: "11px", marginTop: "4px" },
          text: "Le clip précédent est prolongé automatiquement pendant la transition.",
        })
      );
    }
  } else {
    const gain = el("input", { type: "range", min: "0", max: "2", step: "0.02", value: clip.gain });
    gain.addEventListener("input", () => {
      clip.gain = Number(gain.value);
      gain.nextSibling.textContent = clip.gain > 0.01 ? `${Math.round(20 * Math.log10(clip.gain))} dB` : "−∞";
      emit("persist");
      emit("dragging");
    });
    box.append(propRow("Volume", gain, clip.gain > 0.01 ? `${Math.round(20 * Math.log10(clip.gain))} dB` : "−∞"));

    const fadeIn = el("input", { type: "range", min: "0", max: "6", step: "0.1", value: clip.fadeIn });
    fadeIn.addEventListener("input", () => {
      clip.fadeIn = Number(fadeIn.value);
      fadeIn.nextSibling.textContent = `${clip.fadeIn.toFixed(1)} s`;
      emit("persist");
      emit("dragging");
    });
    box.append(propRow("Fondu entrée", fadeIn, `${clip.fadeIn.toFixed(1)} s`));

    const fadeOut = el("input", { type: "range", min: "0", max: "6", step: "0.1", value: clip.fadeOut });
    fadeOut.addEventListener("input", () => {
      clip.fadeOut = Number(fadeOut.value);
      fadeOut.nextSibling.textContent = `${clip.fadeOut.toFixed(1)} s`;
      emit("persist");
      emit("dragging");
    });
    box.append(propRow("Fondu sortie", fadeOut, `${clip.fadeOut.toFixed(1)} s`));

    const loop = el("input", { type: "checkbox", checked: !!clip.loop });
    loop.addEventListener("change", () => {
      clip.loop = loop.checked;
      emit("persist");
    });
    box.append(el("div", { class: "prop-row" }, [el("span", { text: "Boucler la musique" }), loop]));

    const offsetInput = el("input", { type: "number", step: "0.1", value: (clip.offset || 0).toFixed(2), style: { width: "80px" } });
    offsetInput.addEventListener("change", () => {
      clip.offset = Math.max(0, Number(offsetInput.value) || 0);
      emit("persist");
    });
    box.append(el("div", { class: "prop-row" }, [el("span", { text: "Décalage source (s)" }), offsetInput]));
  }

  const actions = el("div", { class: "panel-actions" });
  if (!isAudio) {
    actions.append(
      el("button", {
        class: "primary",
        text: "🎨 Choisir une autre illustration",
        title: "3 nouvelles propositions pour ce mot-clé",
        onclick: async () => {
          let keyword = clip.keyword || "";
          try {
            const data = await api(`/api/projects/${S.project.id}/clips/keyword?clipId=${clip.id}`);
            keyword = data.keyword || keyword;
          } catch {}
          openIllustrationPicker({
            keyword,
            start: clip.start,
            duration: clip.duration,
            replaceClipId: clip.id,
            slot: { start: clip.start, end: clip.start + clip.duration },
          });
        },
      })
    );
    actions.append(
      el("button", {
        text: "🪄 Retoucher l'image",
        title: "Zoom, cadrage, couleurs, détourage…",
        onclick: () => {
          const src = sourceById(clip.sourceId);
          if (!src) return toast("Image introuvable", "error");
          openImageEditor(src, {
            keyword: clip.keyword,
            onDone: (newSource) => {
              clip.sourceId = newSource.id;
              emit("persist");
              emit("render");
              emit("selection-clip", { id: clip.id, kind: "video" });
            },
          });
        },
      })
    );
  }
  actions.append(
    el("button", {
      text: "⏱️ Aligner sur la tête",
      title: "Déplacer le clip au niveau de la tête de lecture",
      onclick: () => {
        clip.start = Math.max(0, S.playhead);
        emit("persist");
        renderSidePanel();
      },
    })
  );
  actions.append(
    el("button", {
      text: "✂️ Couper ici",
      title: "Séparer le clip en deux au niveau de la tête de lecture",
      onclick: () => splitClip(isAudio, clip, track),
    })
  );
  if (!isAudio) {
    const next = clips()
      .filter((c) => c.start > clip.start + 0.05)
      .sort((a, b) => a.start - b.start)[0];
    actions.append(
      el("button", {
        text: "⤢ Étendre jusqu'au suivant",
        title: next ? `Étendre jusqu'à ${fmtTime(next.start)}` : "Étendre jusqu'à la fin de la voix",
        onclick: () => {
          const target = next ? next.start : duration();
          clip.duration = Math.max(0.2, target - clip.start);
          emit("persist");
          renderSidePanel();
        },
      })
    );
  }
  actions.append(
    el("button", {
      class: "danger",
      text: "🗑️ Supprimer",
      onclick: async () => {
        if (isAudio) {
          const t = S.project.audioTracks.find((x) => x.id === track.id);
          t.clips = t.clips.filter((c) => c.id !== clip.id);
        } else {
          S.project.videoTrack = S.project.videoTrack.filter((c) => c.id !== clip.id);
        }
        S.selectedClipId = null;
        emit("persist");
        emit("selection-clip", {});
        emit("render");
        toast("Clip supprimé");
      },
    })
  );
  box.append(actions);
  return box;
}

/** Coupe un clip vidéo ou audio au niveau de la tête de lecture. */
export function splitClip(isAudio, clip, track) {
  const t = S.playhead;
  if (t <= clip.start + 0.2 || t >= clip.start + clip.duration - 0.2) {
    toast("Place la tête de lecture à l'intérieur du clip (au moins 0,2 s des bords)", "error", 6000);
    return;
  }
  const splitOffset = t - clip.start;
  const first = { ...clip, duration: splitOffset };
  const second = {
    ...clip,
    id: `${isAudio ? "clip" : "clip"}_${Math.random().toString(36).slice(2, 9)}`,
    start: t,
    duration: clip.start + clip.duration - t,
    offset: Math.max(0, (clip.offset || 0) + splitOffset),
    effect: clip.effect
      ? { ...clip.effect, transition: { type: "cut", duration: 0 } }
      : undefined,
  };
  if (isAudio) {
    const t2 = S.project.audioTracks.find((x) => x.id === track.id);
    t2.clips = t2.clips.flatMap((c) => (c.id === clip.id ? [first, second] : [c]));
  } else {
    S.project.videoTrack = S.project.videoTrack
      .flatMap((c) => (c.id === clip.id ? [first, second] : [c]))
      .sort((a, b) => a.start - b.start);
  }
  S.selectedClipId = second.id;
  emit("persist");
  emit("render");
  emit("selection-clip", { id: second.id, kind: isAudio ? "audio" : "video" });
  toast(`Clip coupé à ${fmtTime(t)}`, "ok");
}

function renderVoiceInfo() {
  const box = el("div");
  box.append(el("div", { class: "panel-title", text: "🎙️ Voix" }));
  if (!S.build) {
    box.append(el("div", { class: "muted", style: { fontSize: "12px" }, text: "Aucune piste voix compilée." }));
    return box;
  }
  const edits = S.project.voice.edits;
  const rows = [
    ["Durée montée", fmtDuration(S.build.duration)],
    ["Silences accélérés", `${edits.ffwd.length} (×${edits.ffwdFactor})`],
    ["Coupes", `${edits.cuts.length}`],
    ["Débruitage", edits.denoise.mode === "none" ? "aucun" : `${edits.denoise.mode} (${edits.denoise.reduction} dB)`],
    ["Niveau moyen", `${S.build.stats.meanDb} dB`],
    ["Crête", `${S.build.stats.peakDb} dB`],
  ];
  for (const [k, v] of rows) box.append(el("div", { class: "kv" }, [el("span", { text: k }), el("b", { text: v })]));

  const norm = el("input", { type: "checkbox", checked: !!edits.normalize });
  norm.addEventListener("change", async () => {
    const { project } = await api(`/api/projects/${S.project.id}/voice/normalize`, {
      method: "POST",
      body: { enabled: norm.checked },
    });
    adoptProject(project);
    emit("project-external", project);
  });
  box.append(el("div", { class: "prop-row", style: { marginTop: "6px" } }, [el("span", { text: "Normaliser la voix (EBU R128)" }), norm]));
  return box;
}

function renderSetupInfo() {
  const box = el("div");
  renderSetupInto(box);
  return box;
}

export function renderSetupInto(box) {
  const whisper = S.setup?.whisper;
  box.innerHTML = "";
  box.append(el("div", { class: "panel-title", text: "⚙️ Whisper" }));
  if (!whisper) {
    box.append(el("div", { class: "muted", text: "État inconnu…" }));
    return;
  }
  box.append(el("div", { class: "kv" }, [el("span", { text: "Binaire" }), el("b", { text: whisper.binary || "non installé" })]));
  const installed = whisper.models.filter((m) => m.installed);
  box.append(
    el("div", { class: "kv" }, [
      el("span", { text: "Modèles" }),
      el("b", { text: installed.length ? installed.map((m) => m.id.replace("ggml-", "").replace(".bin", "")).join(", ") : "aucun" }),
    ])
  );
  box.append(el("div", { class: "kv" }, [el("span", { text: "RNNoise" }), el("b", { text: whisper.rnnoise || "non installé" })]));
  box.append(el("div", { class: "muted", style: { fontSize: "11px", marginTop: "6px" }, text: "FFmpeg détecté ✓" }));
  renderCacheTool(box);

  const actions = el("div", { class: "panel-actions" });
  if (!whisper.binary || !installed.length) {
    actions.append(
      el("button", {
        class: "primary",
        text: "⬇️ Installer Whisper (small)",
        onclick: () => installWhisper("ggml-small.bin"),
      })
    );
  }
  if (!whisper.rnnoise) {
    actions.append(el("button", { text: "⬇️ Modèle RNNoise", onclick: () => installRnnoise() }));
  }
  if (actions.children.length) box.append(actions);
}

/**
 * Outil « vider le cache » : les clips pré-rendus (recadrage, zoom, transitions)
 * accélèrent l'export. Ils pèsent parfois plusieurs centaines de Mo et deviennent
 * inutiles si l'on veut forcer leur recalcul.
 */
function renderCacheTool(box) {
  if (!S.project) return;
  box.append(el("div", { class: "divider" }));
  box.append(el("div", { class: "panel-title", text: "🧰 Outils" }));
  box.append(
    el("div", {
      class: "muted",
      style: { fontSize: "11px", marginBottom: "6px" },
      text: "Les clips pré-rendus accélèrent l'aperçu et l'export. Les vider libère de la place et force leur recalcul.",
    })
  );
  const button = el("button", {
    text: "🧹 Vider le cache des clips",
    title: "Supprime les clips intermédiaires du projet (les exports suivants les recréent)",
    onclick: async () => {
      button.disabled = true;
      try {
        const { cache } = await api(`/api/projects/${S.project.id}/cache/clear`, { method: "POST" });
        toast(
          cache.files
            ? `Cache vidé : ${cache.files} fichier(s), ${fmtBytes(cache.bytes)} libérés`
            : "Le cache était déjà vide",
          "ok",
          5200
        );
      } catch (e) {
        toast(`Vidage impossible : ${e.message}`, "error");
      } finally {
        button.disabled = false;
      }
    },
  });
  box.append(el("div", { class: "panel-actions" }, [button]));
}

async function installWhisper(model) {
  try {
    const { job } = await api("/api/setup/whisper", { method: "POST", body: { model } });
    trackSetupJob(job, "Installation de Whisper");
  } catch (e) {
    toast(e.message, "error");
  }
}

async function installRnnoise() {
  try {
    const { job } = await api("/api/setup/rnnoise", { method: "POST" });
    trackSetupJob(job, "Téléchargement RNNoise");
  } catch (e) {
    toast(e.message, "error");
  }
}

function trackSetupJob(jobId, label) {
  const node = toast(`${label}…`, "info", 300000);
  watchJob(jobId, (job) => {
    if (job.status === "running") {
      node.textContent = `${label}… ${Math.round(job.progress * 100)}% — ${job.message}`;
      return;
    }
    node.className = `toast ${job.status === "done" ? "ok" : "error"}`;
    node.textContent = job.status === "done" ? `${label} : terminé ✓` : `${label} : ${job.error}`;
    setTimeout(() => node.remove(), 4500);
    if (job.status === "done") emit("refresh-setup");
  });
}
