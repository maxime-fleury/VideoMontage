import { S, on, emit, setProject, adoptProject, duration, clips, allAudioClips } from "./state.js";
import { $, el, api, toast, watchJob, busy, clearBusy, fmtTime, fmtDuration, clamp, openModal, newId, defaultClipEffect } from "./api.js";
import { initWaveform, drawWaveform, scrollToPlayhead } from "./waveform.js";
import { Player, Stage } from "./player.js";
import { initTimeline, renderTimeline, updatePlayhead } from "./timeline.js";
import { initTranscript, renderTranscript } from "./transcript.js";
import { initPanels, renderSidePanel, splitClip } from "./panels.js";
import { initSubtitles, loadSubtitles, openSubtitlesModal, updateSubtitleOverlay } from "./subtitles.js";
import { openRecorder, openExport, openSettings, openProjects, openAuto } from "./modals.js";
import { initLayout } from "./layout.js";
import { initLibrary, renderLibrary } from "./library.js";
import { initHistory } from "./history.js";
import { initPanelsMenu } from "./panelsmenu.js";
import { initTexts, addTextAtPlayhead } from "./texts.js";
import { initOverlayEditor } from "./overlays.js";
import { initAutopilot } from "./autopilot.js";
import { addAudioTrack, addOverlayClip, addVideoLayer, findOverlayClip, removeOverlayClip } from "./tracks.js";

export const player = new Player();
let stage = null;
let toolMode = null;

// ---------------------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------------------
async function boot() {
  initLayout();
  initWaveform();
  initTimeline();
  initTranscript();
  initPanels();
  initSubtitles();
  initLibrary();
  initHistory();
  initPanelsMenu();
  initTexts();
  initOverlayEditor();
  stage = new Stage($("#stage"));
  wireButtons();
  wireEvents();
  wireShortcuts();
  await loadSetup();
  await loadMotions();
  initAutopilot();
  const list = await api("/api/projects");
  if (list.projects.length) {
    const { project } = await api(`/api/projects/${list.projects[0].id}`);
    setProject(project);
  } else {
    const { project } = await api("/api/projects", { method: "POST", body: { name: "Mon premier montage" } });
    setProject(project);
    toast("Projet créé — commence par 🎙️ Enregistrer ou 📁 Importer", "ok", 9000);
  }
}

async function loadSetup() {
  try {
    S.setup = await api("/api/setup/status");
  } catch (e) {
    S.setup = null;
  }
  renderSidePanel();
}

/** Catalogue des placements et mouvements prédéfinis (mêmes gabarits que le rendu). */
async function loadMotions() {
  try {
    S.motions = await api("/api/motions");
  } catch {
    S.motions = null;
  }
}

// ---------------------------------------------------------------------------
// Boutons
// ---------------------------------------------------------------------------
function wireButtons() {
  $("#btnRecord").addEventListener("click", openRecorder);
  $("#btnImport").addEventListener("click", () => pickFiles("any"));
  $("#btnSettings").addEventListener("click", openSettings);
  $("#btnExport").addEventListener("click", openExport);
  $("#projectPill").addEventListener("click", openProjects);

  $("#btnPlay").addEventListener("click", () => (S.playing ? player.pause() : player.play()));
  $("#btnStop").addEventListener("click", () => {
    player.stop();
    player.seek(0);
  });
  $("#seek").addEventListener("input", (e) => player.seek(Number(e.target.value)));
  $("#zoomIn").addEventListener("click", () => emit("zoom", { factor: 1.35, anchorTime: S.playhead }));
  $("#zoomOut").addEventListener("click", () => emit("zoom", { factor: 1 / 1.35, anchorTime: S.playhead }));

  $("#btnCut").addEventListener("click", cutSelection);
  $("#btnCut").disabled = true;
  $("#btnSubtitles").addEventListener("click", openSubtitlesModal);
  wireStageDrop();
  $("#btnSilence").addEventListener("click", () => setTool(toolMode === "silence" ? null : "silence"));
  $("#btnDenoise").addEventListener("click", () => setTool(toolMode === "denoise" ? null : "denoise"));
  $("#btnTranscribe").addEventListener("click", () => setTool(toolMode === "transcribe" ? null : "transcribe"));
  $("#btnAuto").addEventListener("click", openAuto);
  $("#btnReset").addEventListener("click", async () => {
    if (!confirm("Annuler toutes les coupes, accélérations et le débruitage ?")) return;
    await voiceOp("Réinitialisation", () => api(`/api/projects/${S.project.id}/voice/reset`, { method: "POST" }));
  });

  $("#btnAddTrack").addEventListener("click", () => addAudioTrack($("#addTrackKind")?.value || "music"));
  $("#btnAddVideoTrack").addEventListener("click", () => addVideoLayer());
  $("#btnAddText").addEventListener("click", () => addTextAtPlayhead());
  // Amène le panneau « Montage automatique » sous les yeux (le lancement s'y trouve).
  $("#btnAutoFull").addEventListener("click", () => emit("auto-open"));
  $("#btnStageOverlays").addEventListener("click", () => {
    S.showOverlays = !S.showOverlays;
    $("#btnStageOverlays").classList.toggle("active", S.showOverlays);
    stage.showIncrustations = S.showOverlays;
    stage.update(S.playhead);
  });
  $("#btnAddImage").addEventListener("click", () => pickFiles("media"));
}

function pickFiles(mode) {
  const input = $("#fileInput");
  input.value = "";
  input.accept = mode === "media" ? "image/*,video/*" : "audio/*,video/*,image/*";
  input.onchange = () => {
    if (input.files?.length) handleFiles([...input.files]);
  };
  input.click();
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------
async function handleFiles(files) {
  for (const file of files) {
    const kind = file.type.startsWith("image/") ? "image" : file.type.startsWith("video/") ? "video" : "audio";
    if (kind === "image" || kind === "video") await importVisual(file);
    else if (!S.build) await uploadAs(file, "voice");
    else askAudioRole(file);
  }
}

async function uploadFile(file, role) {
  const form = new FormData();
  form.append("file", file);
  form.append("role", role);
  form.append("name", file.name);
  return api(`/api/projects/${S.project.id}/upload`, { method: "POST", form });
}

async function uploadAs(file, role) {
  const node = toast(`Import de ${file.name}…`, "info", 120000);
  try {
    const data = await uploadFile(file, role);
    node.remove();
    adoptProject(data.project);
    emit("project-external", data.project);
    toast(role === "voice" ? "Piste voix importée ✓" : "Fichier importé ✓", "ok");
    return data;
  } catch (e) {
    node.remove();
    toast(`Import impossible : ${e.message}`, "error");
    return null;
  }
}

function askAudioRole(file) {
  openModal((close) =>
    el("div", {}, [
      el("h2", { text: `Que faire de « ${file.name} » ?` }),
      el("div", { class: "muted", style: { fontSize: "12px", marginBottom: "10px" }, text: "Tu peux en faire ta piste voix principale (nouvelle prise) ou l'ajouter comme musique/bruitage sur une piste." }),
      el("div", { class: "panel-actions" }, [
        el("button", {
          class: "primary",
          text: "🎙️ Nouvelle piste voix",
          onclick: async () => {
            close();
            await uploadAs(file, "voice");
          },
        }),
        ...(S.project.audioTracks || []).map((track) =>
          el("button", {
            text: `➕ Sur « ${track.name} »`,
            onclick: async () => {
              close();
              const data = await uploadAs(file, "music");
              if (!data) return;
              const source = data.source;
              const target = S.project.audioTracks.find((t) => t.id === track.id) || S.project.audioTracks[0];
              if (target && source) {
                target.clips.push({
                  id: `clip_${Math.random().toString(36).slice(2, 9)}`,
                  sourceId: source.id,
                  start: Math.max(0, S.playhead),
                  duration: Math.max(0.5, source.duration || 3),
                  offset: 0,
                  gain: 0.6,
                  fadeIn: 0.4,
                  fadeOut: 0.8,
                });
                emit("persist");
                emit("render");
                toast(`Ajouté sur « ${target.name} »`, "ok");
              }
            },
          })
        ),
      ]),
      el("div", { class: "footer" }, [el("button", { text: "Annuler", onclick: close })])
    ])
  );
}

async function importVisual(file) {
  const data = await uploadAs(file, "clip");
  if (!data) return;
  const source = data.source;
  const clip = {
    id: `clip_${Math.random().toString(36).slice(2, 9)}`,
    sourceId: source.id,
    keyword: file.name.replace(/\.[a-z0-9]+$/i, ""),
    start: Math.max(0, S.playhead),
    duration: file.type.startsWith("video/") ? Math.min(Math.max(1, source.duration), 8) : 3,
    offset: 0,
    effect: { fadeIn: 0.4, fadeOut: 0.4, kenBurns: false, zoomFrom: 1, zoomTo: 1.12 },
    createdAt: Date.now(),
  };
  S.project.videoTrack.push(clip);
  S.project.videoTrack.sort((a, b) => a.start - b.start);
  emit("persist");
  emit("render");
  toast(`Clip ajouté à ${fmtTime(clip.start)}`, "ok");
}

// ---------------------------------------------------------------------------
// Opérations voix
// ---------------------------------------------------------------------------
async function voiceOp(label, fn) {
  busy(label, 0.2);
  try {
    const data = await fn();
    if (data.project) {
      adoptProject(data.project);
      emit("project-external", data.project);
    }
    for (const warning of data.warnings || []) toast(warning, "error", 8000);
    return data;
  } catch (e) {
    toast(e.message, "error", 8000);
    return null;
  } finally {
    clearBusy();
  }
}

/**
 * ✂️ / touche C — lame :
 * 1. clip sélectionné -> coupe ce clip à la tête de lecture
 * 2. sinon -> coupe tous les clips (vidéo + audio) sous la tête de lecture
 * 3. sinon -> coupe la sélection de la forme d'onde
 */
async function cutSelection() {
  if (S.selectedClipId) {
    const isAudio = S.selectedClipKind === "audio";
    const all = isAudio ? allAudioClips() : clips().map((clip) => ({ clip }));
    const entry = all.find((e) => e.clip?.id === S.selectedClipId);
    if (entry?.clip) {
      splitClip(isAudio, entry.clip, entry.track);
      return;
    }
  }
  if (bladeAtPlayhead()) return;
  if (!S.build) return toast("Aucune piste voix", "error");
  if (!S.selection) {
    return toast("Sélectionne une zone sur la forme d'onde, ou place la tête de lecture sur un clip", "error", 6000);
  }
  const { start, end } = S.selection;
  await voiceOp("Coupe…", () =>
    api(`/api/projects/${S.project.id}/voice/cut`, { method: "POST", body: { start, end } })
  );
  S.selection = null;
  emit("selection");
  emit("render-waveform");
}

/** Coupe au niveau de la tête de lecture tout ce qui passe dessous. */
function bladeAtPlayhead() {
  const t = S.playhead;
  const inside = (clip) => t > clip.start + 0.15 && t < clip.start + clip.duration - 0.15;
  const videoTargets = clips().filter(inside);
  const audioTargets = allAudioClips().filter(({ clip }) => inside(clip));
  if (!videoTargets.length && !audioTargets.length) return false;

  for (const clip of videoTargets) {
    const second = {
      ...clip,
      id: newId("clip"),
      start: t,
      duration: clip.start + clip.duration - t,
      effect: clip.effect ? { ...clip.effect, transition: { type: "cut", duration: 0 } } : undefined,
    };
    clip.duration = t - clip.start;
    S.project.videoTrack.push(second);
  }
  S.project.videoTrack.sort((a, b) => a.start - b.start);
  for (const { track, clip } of audioTargets) {
    const second = { ...clip, id: newId("clip"), start: t, duration: clip.start + clip.duration - t, offset: (clip.offset || 0) + (t - clip.start) };
    clip.duration = t - clip.start;
    track.clips.push(second);
  }
  S.selectedClipIds = [];
  S.selectedClipId = null;
  emit("persist");
  emit("render");
  toast(`${videoTargets.length + audioTargets.length} élément(s) coupé(s) à ${fmtTime(t)} — clique un morceau puis Suppr pour le retirer`, "ok", 6000);
  return true;
}

/** Dépôt de médias: fichiers glissés sur la scène ou la timeline. */
async function handleDrop({ files, time, target, trackId, layerId }) {
  for (const file of files) {
    const kind = file.type.startsWith("image/") ? "image" : file.type.startsWith("video/") ? "video" : "audio";
    if (kind === "audio" && target === "voice") {
      await uploadAs(file, "voice");
      continue;
    }
    const wantsOverlay = target === "overlay" && kind !== "audio";
    const data = await uploadAs(file, target === "video" && kind !== "audio" ? "clip" : wantsOverlay ? "clip" : "music");
    if (!data?.source) continue;
    const source = data.source;
    if (wantsOverlay) {
      const layer = (S.project.overlayLayers || []).find((l) => l.id === layerId) || (S.project.overlayLayers || [])[0];
      if (!layer) {
        toast("Ajoute d'abord une piste vidéo (＋ Piste vidéo)", "error");
        continue;
      }
      const clip = addOverlayClip(layer.id, source, time);
      if (clip) emit("selection-clip", { id: clip.id, kind: "overlay", ids: [clip.id] });
      continue;
    }
    if (kind === "audio") {
      let track = S.project.audioTracks.find((t) => t.id === trackId);
      if (!track) track = S.project.audioTracks[0];
      if (!track) {
        track = { id: newId("trk"), name: "Piste 1", kind: "music", muted: false, clips: [] };
        S.project.audioTracks.push(track);
      }
      track.clips.push({
        id: newId("clip"),
        sourceId: source.id,
        start: Math.max(0, time),
        duration: Math.max(0.5, source.duration || 3),
        offset: 0,
        gain: 0.6,
        fadeIn: 0.3,
        fadeOut: 0.6,
      });
      toast(`« ${source.name} » posé sur ${track.name} à ${fmtTime(time)}`, "ok");
    } else {
      const clip = {
        id: newId("clip"),
        sourceId: source.id,
        keyword: file.name.replace(/\.[a-z0-9]+$/i, ""),
        start: Math.max(0, time),
        duration: kind === "video" ? clamp(source.duration || 4, 1, 20) : 3,
        offset: 0,
        effect: defaultClipEffect(),
        createdAt: Date.now(),
      };
      S.project.videoTrack.push(clip);
      S.project.videoTrack.sort((a, b) => a.start - b.start);
      toast(`Clip ajouté à ${fmtTime(clip.start)}`, "ok");
    }
  }
  emit("persist");
  emit("render");
}

function wireStageDrop() {
  const stage = $("#stage");
  stage.addEventListener("dragover", (e) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault();
    stage.style.outline = "2px dashed var(--accent-2)";
  });
  stage.addEventListener("dragleave", () => (stage.style.outline = ""));
  stage.addEventListener("drop", (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    stage.style.outline = "";
    handleDrop({ files: [...e.dataTransfer.files], time: S.playhead, target: "video", trackId: null });
  });
}

// ---------------------------------------------------------------------------
// Options d'outils (silences, débruitage, transcription)
// ---------------------------------------------------------------------------
function setTool(mode) {
  toolMode = mode;
  $("#btnSilence").classList.toggle("active", mode === "silence");
  $("#btnDenoise").classList.toggle("active", mode === "denoise");
  $("#btnTranscribe").classList.toggle("active", mode === "transcribe");
  renderToolOptions();
}

function renderToolOptions() {
  const host = $("#toolOptions");
  host.innerHTML = "";
  host.classList.toggle("hidden", !toolMode);
  if (!toolMode) return;

  if (toolMode === "silence") {
    // Seuil « auto » : mesuré sur le plancher de bruit réel de la prise (voir /voice/detect).
    const autoBox = el("input", { type: "checkbox", checked: true });
    const auto = el("label", { class: "opt", title: "Mesure le bruit de fond de la prise pour choisir le seuil" }, [
      autoBox,
      el("span", { text: "Seuil auto" }),
    ]);
    const threshold = rangeOpt("Seuil", -60, -20, 1, -35, "dB");
    threshold.node.title = "Utilisé seulement si « Seuil auto » est décoché";
    const minDur = rangeOpt("Durée mini", 0.15, 1.5, 0.05, 0.35, "s");
    const factor = rangeOpt("Facteur", 2, 100, 1, 100, "×");
    const info = el("span", { class: "muted", style: { fontSize: "11px" } });
    const syncThreshold = () => {
      threshold.node.querySelector("input").disabled = autoBox.checked;
      threshold.node.style.opacity = autoBox.checked ? "0.5" : "1";
    };
    autoBox.addEventListener("change", syncThreshold);
    syncThreshold();

    const detect = el("button", { text: "🔍 Analyser", onclick: async () => {
      info.textContent = "Analyse du plancher de bruit…";
      try {
        const data = await api(`/api/projects/${S.project.id}/voice/detect`, {
          method: "POST",
          body: { thresholdDb: autoBox.checked ? "auto" : threshold.get(), minDuration: minDur.get() },
        });
        S.detected = data.inOut;
        emit("render");
        const noise = data.analysis
          ? ` · seuil auto ${data.thresholdDb} dB (plancher ${data.analysis.noiseFloorDb} dB)`
          : ` · seuil manuel ${data.thresholdDb} dB`;
        info.textContent = `${data.silences.length} silences · ${data.total.toFixed(1)} s → ${data.savedAtX100.toFixed(1)} s gagnées à ×${factor.get()}${noise}`;
      } catch (e) {
        info.textContent = `Analyse impossible : ${e.message}`;
      }
    }});
    const apply = el("button", { class: "primary", text: "⏩ Appliquer", onclick: async () => {
      await voiceOp("Accélération des silences…", () =>
        api(`/api/projects/${S.project.id}/voice/ffwd`, {
          method: "POST",
          body: {
            enabled: true,
            thresholdDb: autoBox.checked ? "auto" : threshold.get(),
            minDuration: minDur.get(),
            factor: factor.get(),
          },
        })
      );
      S.detected = null;
    }});
    const undo = el("button", { text: "↩️ Ne plus accélérer", onclick: async () => {
      await voiceOp("Retour à la normale…", () => api(`/api/projects/${S.project.id}/voice/ffwd`, { method: "POST", body: { enabled: false } }));
      S.detected = null;
    }});
    host.append(auto, threshold.node, minDur.node, factor.node, detect, apply, undo, info);
    return;
  }

  if (toolMode === "denoise") {
    const mode = el("select", {}, [
      el("option", { value: "none", text: "Aucun" }),
      el("option", { value: "profile", text: "Profil sur un blanc" }),
      el("option", { value: "auto", text: "Auto (adaptatif)" }),
      el("option", { value: "rnnoise", text: "RNNoise (IA)" }),
    ]);
    mode.value = S.project?.voice?.edits?.denoise?.mode === "none" ? "none" : S.project.voice.edits.denoise.mode || "none";
    const reduction = rangeOpt("Réduction", 1, 30, 1, S.project?.voice?.edits?.denoise?.reduction ?? 12, "dB");
    const info = el("span", { class: "muted", style: { fontSize: "11px" } });
    if (S.project?.voice?.edits?.denoise?.floorDb) info.textContent = `plancher mesuré : ${S.project.voice.edits.denoise.floorDb} dB`;

    const analyse = el("button", {
      text: "🎯 Analyser le blanc sélectionné",
      title: "Sélectionne une zone de silence sur la forme d'onde (ex: 0,5 s avant que tu parles), puis clique ici",
      onclick: async () => {
        if (!S.selection) return toast("Sélectionne d'abord une zone de silence sur la forme d'onde", "error");
        const data = await voiceOp("Analyse du bruit de fond…", () =>
          api(`/api/projects/${S.project.id}/voice/denoise`, {
            method: "POST",
            body: { mode: "profile", reduction: reduction.get(), sample: S.selection },
          })
        );
        if (data?.measured) toast(`Bruit de fond mesuré : ${data.measured.rmsDb} dB — réduction appliquée`, "ok", 7000);
        renderToolOptions();
      },
    });
    const apply = el("button", { class: "primary", text: "✅ Appliquer", onclick: async () => {
      await voiceOp("Débruitage en cours…", () =>
        api(`/api/projects/${S.project.id}/voice/denoise`, {
          method: "POST",
          body: {
            mode: mode.value,
            reduction: reduction.get(),
            sample: mode.value === "profile" ? S.selection : null,
          },
        })
      );
      renderToolOptions();
    }});
    const remove = el("button", { text: "↩️ Retirer le débruitage", onclick: async () => {
      await voiceOp("Suppression du débruitage…", () => api(`/api/projects/${S.project.id}/voice/denoise`, { method: "POST", body: { mode: "none" } }));
    }});
    host.append(mode, reduction.node, analyse, apply, remove, info);
    return;
  }

  if (toolMode === "transcribe") {
    const models = (S.setup?.whisper?.models || []).filter((m) => m.installed);
    const model = el("select", {}, models.length ? models.map((m) => el("option", { value: m.id, text: m.label })) : [el("option", { value: "ggml-small.bin", text: "small (à installer)" })]);
    model.value = S.project?.transcript?.model && models.some((m) => m.id === S.project.transcript.model) ? S.project.transcript.model : models.find((m) => m.id === "ggml-small.bin")?.id || models[0]?.id || "ggml-small.bin";
    const language = el("select", {}, [
      el("option", { value: "fr", text: "Français" }),
      el("option", { value: "en", text: "Anglais" }),
      el("option", { value: "auto", text: "Détection auto" }),
    ]);
    const info = el("span", { class: "muted", style: { fontSize: "11px" } });
    const run = el("button", {
      class: "primary",
      text: "▶️ Lancer la transcription",
      onclick: async () => {
        if (!S.setup?.whisper?.binary || !models.length) {
          toast("Whisper n'est pas installé — ouvre ⚙️ Réglages", "error", 8000);
          return;
        }
        try {
          const { job } = await api(`/api/projects/${S.project.id}/transcribe`, {
            method: "POST",
            body: { model: model.value, language: language.value },
          });
          toast("Transcription lancée — cela peut prendre quelques minutes", "info");
          watchJob(job, async (state) => {
            if (state.status === "running") {
              busy("Transcription Whisper", state.progress, state.message);
              return;
            }
            clearBusy();
            if (state.status === "error") {
              toast(`Transcription échouée : ${state.error}`, "error", 9000);
              return;
            }
            const { project } = await api(`/api/projects/${S.project.id}`);
            adoptProject(project);
            emit("project-external", project);
            toast(`Transcription terminée : ${state.result?.segments} phrases ✓`, "ok");
          });
        } catch (e) {
          toast(e.message, "error");
        }
      },
    });
    host.append(model, language, run, info);
  }
}

function rangeOpt(label, min, max, step, value, unit) {
  const input = el("input", { type: "range", min, max, step, value: String(value) });
  const val = el("span", { class: "val", text: `${value} ${unit}` });
  input.addEventListener("input", () => (val.textContent = `${input.value} ${unit}`));
  const node = el("div", { class: "opt" }, [el("span", { text: label }), input, val]);
  return { node, value: input, get: () => Number(input.value) };
}

// ---------------------------------------------------------------------------
// Événements globaux
// ---------------------------------------------------------------------------
function wireEvents() {
  on("seek", (t) => player.seek(t));
  on("selection", () => {
    $("#btnCut").disabled = !S.selection;
    if (S.selection) toast(`Sélection ${fmtTime(S.selection.start)} → ${fmtTime(S.selection.end)} (${(S.selection.end - S.selection.start).toFixed(2)} s)`, "info", 2500);
  });
  on("playing", () => {
    $("#btnPlay").textContent = S.playing ? "⏸" : "▶";
  });

  on("tick", () => {
    stage?.update(S.playhead);
    updatePlayhead();
    drawWaveform();
    const now = $("#timeNow");
    if (now) now.textContent = fmtTime(S.playhead);
    const seek = $("#seek");
    if (seek && document.activeElement !== seek) seek.value = String(S.playhead);
    if (S.playing) scrollToPlayhead();
  });

  on("project", (project) => {
    const name = $("#projectName");
    const sub = $("#projectSub");
    if (name) name.textContent = project?.name || "Aucun projet";
    if (sub) {
      const parts = [];
      if (S.build) parts.push(fmtDuration(S.build.duration));
      if (project?.transcript) parts.push(`${project.transcript.segments.length} phrases`);
      parts.push(`${project?.videoTrack?.length || 0} clips`);
      sub.textContent = parts.join(" · ");
    }
    const total = $("#timeTotal");
    if (total) total.textContent = fmtDuration(duration());
    const seek = $("#seek");
    if (seek) seek.max = String(Math.max(duration(), 0.1));
    if (S.build?.audioUrl) player.setSource(S.build.audioUrl);
    if (!S.zoomInitialized && S.build) fitZoom();
    loadSubtitles();
    renderAll();
    updateSteps();
  });

  on("project-external", (project) => {
    setProject(project);
    player.setSource(S.build?.audioUrl);
    renderAll();
    updateSteps();
  });

  on("render", () => renderAll());
  on("drop-media", (payload) => handleDrop(payload));
  on("render-waveform", () => drawWaveform());
  on("refresh-setup", async () => {
    await loadSetup();
    renderToolOptions();
  });
  on("subtitles", () => updateSubtitleOverlay());
  on("zoom", ({ factor, anchorTime }) => {
    const anchor = anchorTime ?? S.playhead;
    const before = anchor * S.pxPerSec - S.scroll;
    S.pxPerSec = clamp(S.pxPerSec * factor, 6, 600);
    S.scroll = Math.max(0, anchor * S.pxPerSec - before);
    $("#zoomLabel").textContent = `${Math.round(S.pxPerSec)} px/s`;
    renderAll();
  });
  on("scroll", (left) => {
    const waveWrap = $("#waveWrap");
    if (waveWrap && Math.abs(waveWrap.scrollLeft - left) > 0.5) waveWrap.scrollLeft = left;
    const tl = $("#timelineScroll");
    if (tl && Math.abs(tl.scrollLeft - left) > 0.5) tl.scrollLeft = left;
  });
}

function fitZoom() {
  const dur = duration();
  const wrap = $("#waveWrap");
  if (!dur || !wrap?.clientWidth) return;
  S.pxPerSec = clamp((wrap.clientWidth - 24) / dur, 1.2, 400);
  S.zoomInitialized = true;
  const label = $("#zoomLabel");
  if (label) label.textContent = `${Math.round(S.pxPerSec)} px/s`;
}

function renderAll() {
  drawWaveform();
  renderTimeline();
  renderTranscript();
  renderSidePanel();
  stage?.rebuild();
  stage?.update(S.playhead);
  updatePlayhead();
  updateSubtitleOverlay();
}

function updateSteps() {
  const edits = S.project?.voice?.edits;
  const done = {
    1: !!S.build,
    2: !!S.build && (edits.cuts.length > 0 || edits.ffwd.length > 0 || edits.denoise.mode !== "none"),
    3: !!S.project?.transcript,
    4: (S.project?.videoTrack?.length || 0) > 0,
    5: !!S.exported,
  };
  const current = !done[1] ? 1 : !done[2] ? 2 : !done[3] ? 3 : !done[4] ? 4 : 5;
  for (const node of document.querySelectorAll(".step")) {
    const step = Number(node.dataset.step);
    node.classList.toggle("done", !!done[step]);
    node.classList.toggle("current", step === current && !done[step]);
  }
}

// ---------------------------------------------------------------------------
// Raccourcis clavier
// ---------------------------------------------------------------------------
function wireShortcuts() {
  document.addEventListener("keydown", (e) => {
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (e.metaKey || e.ctrlKey) return;
    const step = e.shiftKey ? 5 : 1;
    switch (e.key) {
      case " ":
        e.preventDefault();
        S.playing ? player.pause() : player.play();
        break;
      case "ArrowLeft":
        player.seek(S.playhead - step);
        break;
      case "ArrowRight":
        player.seek(S.playhead + step);
        break;
      case "c":
      case "C":
        cutSelection();
        break;
      case "s":
      case "S":
        setTool(toolMode === "silence" ? null : "silence");
        break;
      case "d":
      case "D":
        setTool(toolMode === "denoise" ? null : "denoise");
        break;
      case "t":
      case "T":
        setTool(toolMode === "transcribe" ? null : "transcribe");
        break;
      case "+":
      case "=":
        emit("zoom", { factor: 1.35, anchorTime: S.playhead });
        break;
      case "-":
        emit("zoom", { factor: 1 / 1.35, anchorTime: S.playhead });
        break;
      case "Delete":
      case "Backspace":
        emit("delete-selected");
        break;
      case "v":
      case "V":
        addVideoLayer();
        break;
      case "x":
      case "X":
        addTextAtPlayhead();
        break;
    }
  });
}

on("delete-selected", () => {
  const ids = S.selectedClipIds?.length ? [...S.selectedClipIds] : S.selectedClipId ? [S.selectedClipId] : [];
  if (!ids.length) return;
  S.project.videoTrack = S.project.videoTrack.filter((c) => !ids.includes(c.id));
  for (const track of S.project.audioTracks) track.clips = track.clips.filter((c) => !ids.includes(c.id));
  for (const layer of S.project.overlayLayers || []) layer.clips = layer.clips.filter((c) => !ids.includes(c.id));
  S.project.texts = (S.project.texts || []).filter((t) => !ids.includes(t.id));
  if (S.selectedTextId && ids.includes(S.selectedTextId)) S.selectedTextId = null;
  S.selectedClipId = null;
  S.selectedClipIds = [];
  emit("persist");
  emit("render");
  emit("selection-clip", {});
  toast(ids.length > 1 ? `${ids.length} clips supprimés` : "Clip supprimé", "ok");
});

boot().catch((e) => {
  console.error(e);
  toast(`Erreur au démarrage : ${e.message}`, "error", 15000);
});
