import { S, duration, emit, on, sourceById, adoptProject } from "./state.js";
import { MIME_DRAG } from "./library.js";
import { $, $$, clamp, api, toast, el } from "./api.js";
import {
  addText,
  addVideoLayer,
  moveVideoLayer,
  removeAudioTrack,
  removeVideoLayer,
  renameAudioTrack,
  renameVideoLayer,
  toggleAudioMute,
  toggleVideoLayerHidden,
  audioKindInfo,
} from "./tracks.js";

let ruler, laneVideo, laneOverlays, laneVoice, laneAudio, laneTexts, labelsEl, playhead, timelineScroll, timelineEl;
let dragState = null;
let saveTimer = null;

const LANE_H = 36;
/** Largeur de la colonne des libellés (doit rester alignée avec .labels en CSS). */
const LABEL_W = 150;

export function initTimeline() {
  ruler = $("#ruler");
  laneVideo = $("#laneVideo");
  laneOverlays = $("#laneOverlays");
  laneVoice = $("#laneVoice");
  laneAudio = $("#laneAudio");
  laneTexts = $("#laneTexts");
  labelsEl = $("#labels");
  playhead = $("#playhead");
  timelineScroll = $("#timelineScroll");
  timelineEl = $("#timeline");

  ruler.addEventListener("mousedown", (e) => {
    emit("seek", timeAt(e, ruler));
  });
  laneVoice.addEventListener("mousedown", (e) => {
    if (e.target === laneVoice) emit("seek", timeAt(e, laneVoice));
  });
  timelineScroll.addEventListener("scroll", () => {
    S.scroll = timelineScroll.scrollLeft;
    emit("scroll", S.scroll);
  });
  wireDropZone();

  on("project", renderTimeline);
  on("tick", updatePlayhead);
  on("zoom", renderTimeline);
  on("dragging", renderTimeline);
  on("persist", persist);
  on("render", renderTimeline);
  window.addEventListener("resize", renderTimeline);
}

/** Glisser-déposer de fichiers média directement sur la timeline. */
function wireDropZone() {
  const host = $("#lanes");
  if (!host) return;

  const resolveTarget = (event) => {
    const lane = event.target.closest?.(".lane");
    if (!lane) return { target: "video", trackId: null, layerId: null, lane: null };
    if (lane.dataset.layerId) return { target: "overlay", trackId: null, layerId: lane.dataset.layerId, lane };
    if (lane.dataset.trackId) return { target: "audio", trackId: lane.dataset.trackId, layerId: null, lane };
    if (lane.dataset.laneKind === "text") return { target: "texts", trackId: null, layerId: null, lane };
    if (lane.dataset.laneKind === "voice" || lane.id === "laneVoice") return { target: "voice", trackId: null, layerId: null, lane };
    return { target: "video", trackId: null, layerId: null, lane };
  };

  const clearHighlights = () => {
    for (const lane of $$(".lane.drop-active")) lane.classList.remove("drop-active");
  };

  // Deux origines possibles : des fichiers du disque, ou un média de la médiathèque.
  const hasFiles = (e) => Boolean(e.dataTransfer?.types?.includes("Files"));
  const hasSource = (e) => Boolean(e.dataTransfer?.types?.includes(MIME_DRAG));

  host.addEventListener("dragover", (e) => {
    if (!hasFiles(e) && !hasSource(e)) return;
    e.preventDefault();
    if (hasSource(e)) e.dataTransfer.dropEffect = "copy";
    clearHighlights();
    const { target, lane } = resolveTarget(e);
    if (lane && target !== "texts") lane.classList.add("drop-active");
  });
  host.addEventListener("dragleave", clearHighlights);
  host.addEventListener("drop", (e) => {
    if (!hasFiles(e) && !hasSource(e)) return;
    e.preventDefault();
    clearHighlights();
    const { target, trackId, layerId, lane } = resolveTarget(e);
    if (target === "texts") {
      toast("Dépose les médias sur une piste vidéo ou audio ; pour un texte, clique « + Texte »", "info", 4000);
      return;
    }
    const time = lane ? timeAt(e, lane) : S.playhead;
    if (hasSource(e)) {
      const sourceId = e.dataTransfer.getData(MIME_DRAG);
      if (sourceId) emit("library-add", { sourceId, time, target, trackId, layerId });
      return;
    }
    if (!e.dataTransfer?.files?.length) return;
    emit("drop-media", { files: [...e.dataTransfer.files], time, target, trackId, layerId });
  });
}

function timeAt(e, laneEl) {
  const rect = laneEl.getBoundingClientRect();
  return clamp((e.clientX - rect.left) / S.pxPerSec, 0, Math.max(duration(), 1));
}

function px(t) {
  return t * S.pxPerSec;
}

function styleLane(lane) {
  lane.style.width = `${Math.max(duration() * S.pxPerSec, 400)}px`;
  lane.style.height = `${LANE_H}px`;
}

function makeGrid(lane, dur) {
  const frag = document.createDocumentFragment();
  const step = S.pxPerSec > 90 ? 1 : S.pxPerSec > 35 ? 5 : 15;
  for (let t = 0; t <= dur; t += step) {
    const div = document.createElement("div");
    div.className = `grid${t % (step * 5) === 0 ? " major" : ""}`;
    div.style.left = `${px(t)}px`;
    frag.append(div);
  }
  lane.append(frag);
}

function renderRuler() {
  const dur = Math.max(duration(), 1);
  ruler.innerHTML = "";
  styleLane(ruler);
  ruler.style.height = "24px";
  const frag = document.createDocumentFragment();
  const step = S.pxPerSec > 90 ? 1 : S.pxPerSec > 35 ? 5 : 15;
  for (let t = 0; t <= dur; t += step) {
    const tick = document.createElement("div");
    tick.className = "ruler-tick";
    tick.style.left = `${px(t)}px`;
    const label = t % (step * 5) === 0 ? `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}` : "";
    tick.innerHTML = label ? `<span>${label}</span>` : "";
    frag.append(tick);
  }
  ruler.append(frag);
}

function clipEl(kind, extraClass) {
  const div = document.createElement("div");
  div.className = `clip ${kind}${extraClass ? ` ${extraClass}` : ""}`;
  return div;
}

/** Sélection (additive avec Ctrl/Maj: permet de supprimer plusieurs morceaux). */
function selectClip(id, kind, additive = false) {
  if (!additive) S.selectedClipIds = [id];
  else if (S.selectedClipIds.includes(id)) S.selectedClipIds = S.selectedClipIds.filter((x) => x !== id);
  else S.selectedClipIds = [...S.selectedClipIds, id];
  S.selectedClipId = S.selectedClipIds[S.selectedClipIds.length - 1] || null;
  S.selectedClipKind = kind;
  emit("selection-clip", { id: S.selectedClipId, kind, ids: S.selectedClipIds });
  for (const node of document.querySelectorAll(".clip.selected")) node.classList.remove("selected");
  for (const selected of S.selectedClipIds) {
    const node = document.querySelector(`.clip[data-id="${selected}"]`);
    if (node) node.classList.add("selected");
  }
}

function startDrag(e, clip, mode, kind, extra = {}) {
  e.stopPropagation();
  dragState = {
    clip,
    mode, // move | trim-left | trim-right
    kind,
    ...extra,
    startX: e.clientX,
    orig: { start: clip.start, duration: clip.duration, offset: clip.offset || 0 },
  };
  if (!S.selectedClipIds.includes(clip.id)) selectClip(clip.id, kind, e.ctrlKey || e.metaKey || e.shiftKey);
  window.addEventListener("mousemove", onDragMove);
  window.addEventListener("mouseup", onDragEnd);
}

function onDragMove(e) {
  if (!dragState) return;
  const { clip, mode, orig } = dragState;
  const delta = (e.clientX - dragState.startX) / S.pxPerSec;
  const limit = dragState.limit ?? duration();
  if (mode === "move") {
    clip.start = Math.max(0, Math.min(Math.max(0.1, limit - 0.2), orig.start + delta));
  } else if (mode === "trim-left") {
    // Un texte n'a pas de décalage dans une source : on ne rogne que sa durée.
    const canOffset = dragState.kind !== "text";
    const newStart = clamp(
      orig.start + delta,
      canOffset ? Math.max(0, orig.start - orig.offset) : 0,
      orig.start + orig.duration - 0.2
    );
    clip.start = newStart;
    clip.duration = orig.duration - (newStart - orig.start);
    if (canOffset) clip.offset = Math.max(0, orig.offset + (newStart - orig.start));
  } else {
    clip.duration = Math.max(0.2, Math.min(orig.duration + delta, limit - clip.start, 3600));
  }
  emit("dragging");
  renderTimeline();
}

function onDragEnd() {
  window.removeEventListener("mousemove", onDragMove);
  window.removeEventListener("mouseup", onDragEnd);
  dragState = null;
  persist();
}

function persist() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    if (!S.project) return;
    try {
      const { project } = await api(`/api/projects/${S.project.id}/update`, {
        method: "POST",
        body: {
          videoTrack: S.project.videoTrack,
          audioTracks: S.project.audioTracks,
          overlayLayers: S.project.overlayLayers,
          texts: S.project.texts,
        },
      });
      // On conserve l'identité des objets locaux (éditeurs et aperçu ouverts).
      adoptProject(project);
      emit("saved");
    } catch (e) {
      toast(`Sauvegarde impossible : ${e.message}`, "error");
    }
  }, 260);
}

// ---------------------------------------------------------------------------
// Colonne des libellés (une ligne par lane, dans le même ordre)
// ---------------------------------------------------------------------------
function renderLabels(rows) {
  if (!labelsEl) return;
  labelsEl.innerHTML = "";
  for (const row of rows) {
    const node = el("div", {
      class: `label-row${row.className ? ` ${row.className}` : ""}`,
      title: row.title || "",
    });
    node.append(el("span", { class: "label-name", text: row.text }));
    if (row.count) node.append(el("span", { class: "muted label-count", text: String(row.count) }));
    if (row.controls?.length) node.append(el("span", { class: "label-tools" }, row.controls));
    labelsEl.append(node);
  }
}

function iconButton(text, title, onclick, className = "") {
  return el("button", { class: `ghost icon label-btn ${className}`.trim(), text, title, onclick });
}

/** Renommage en place : le libellé devient un champ de saisie. */
function renameInline(node, current, onDone) {
  const input = el("input", { class: "label-input", type: "text", value: current });
  const finish = (save) => {
    const value = input.value.trim();
    input.replaceWith(el("span", { class: "label-name", text: save && value ? value : current }));
    if (save && value) onDone(value);
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
  node.replaceWith(input);
  input.focus();
  input.select();
}

// ---------------------------------------------------------------------------
// Rendu
// ---------------------------------------------------------------------------
export function renderTimeline() {
  if (!timelineEl) return;
  const dur = Math.max(duration(), 1);
  renderRuler();

  const width = Math.max(dur * S.pxPerSec, 400);
  timelineEl.style.width = `${width + LABEL_W}px`;

  // --- piste vidéo principale ---
  laneVideo.innerHTML = "";
  styleLane(laneVideo);
  laneVideo.dataset.laneKind = "video";
  makeGrid(laneVideo, dur);
  for (const clip of S.project?.videoTrack || []) {
    const node = clipEl("video");
    node.dataset.id = clip.id;
    const clipWidth = Math.max(8, px(clip.duration));
    node.style.left = `${px(clip.start)}px`;
    node.style.width = `${clipWidth}px`;
    // Clip très court (zoom faible) : l'étiquette serait illisible, on la masque.
    if (clipWidth < 34) node.classList.add("tiny");
    const source = sourceById(clip.sourceId);
    if (source?.kind === "image") {
      node.style.backgroundImage = `url("${source.url}")`;
    } else if (source?.kind === "video") {
      const video = document.createElement("video");
      video.src = source.url;
      video.muted = true;
      video.preload = "metadata";
      video.addEventListener("loadedmetadata", () => {
        video.currentTime = clamp(clip.offset || 0, 0, Math.max(0, (video.duration || 1) - 0.1));
      });
      video.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:0.85;";
      node.append(video);
    }
    addFades(node, clip);
    addTransitionBadge(node, clip.effect?.transition, clipWidth < 90);
    const shortLabel = clipWidth < 74;
    node.append(
      Object.assign(document.createElement("div"), {
        className: "clip-label",
        textContent: shortLabel ? clip.keyword || "clip" : `🖼️ ${clip.keyword || source?.name || "clip"}`,
      })
    );
    node.title = "Clic simple = sélectionner · double-clic = changer d'illustration · glisser = déplacer";
    node.addEventListener("dblclick", (event) => {
      event.stopPropagation();
      import("./illustrations.js").then(async ({ openIllustrationPicker }) => {
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
      });
    });
    if (S.selectedClipIds?.includes(clip.id)) node.classList.add("selected");
    addHandles(node, clip, "video", null);
    laneVideo.append(node);
  }

  // --- calques vidéo (superpositions) ---
  laneOverlays.innerHTML = "";
  const layers = S.project?.overlayLayers || [];
  for (const layer of layers) {
    const lane = document.createElement("div");
    lane.className = `lane overlay-lane${layer.hidden ? " layer-hidden" : ""}`;
    lane.dataset.layerId = layer.id;
    lane.dataset.laneKind = "overlay";
    styleLane(lane);
    makeGrid(lane, dur);
    for (const clip of layer.clips || []) {
      const node = clipEl("overlay", clip.motion?.preset && clip.motion.preset !== "none" ? "moved" : "");
      node.dataset.id = clip.id;
      const clipWidth = Math.max(8, px(clip.duration));
      node.style.left = `${px(clip.start)}px`;
      node.style.width = `${clipWidth}px`;
      if (clipWidth < 34) node.classList.add("tiny");
      const source = sourceById(clip.sourceId);
      if (source?.kind === "image") node.style.backgroundImage = `url("${source.url}")`;
      const motionLabel = clip.motion?.preset && clip.motion.preset !== "none" ? "🎞️ " : "🖼️ ";
      node.append(
        Object.assign(document.createElement("div"), {
          className: "clip-label",
          textContent: clipWidth < 74 ? source?.name || "incrustation" : `${motionLabel}${source?.name || "incrustation"}`,
        })
      );
      node.title = `${source?.name || ""} — double-clic : placements et mouvements`;
      node.addEventListener("dblclick", (event) => {
        event.stopPropagation();
        emit("edit-overlay", { layerId: layer.id, clipId: clip.id });
      });
      if (S.selectedClipIds?.includes(clip.id)) node.classList.add("selected");
      addHandles(node, clip, "overlay", null, { layerId: layer.id });
      lane.append(node);
    }
    laneOverlays.append(lane);
  }

  // --- piste voix ---
  laneVoice.innerHTML = "";
  styleLane(laneVoice);
  laneVoice.dataset.laneKind = "voice";
  makeGrid(laneVoice, dur);
  if (S.build) {
    const node = clipEl("voice");
    node.style.left = "0px";
    node.style.width = `${Math.max(8, px(dur))}px`;
    node.dataset.id = "voice";
    node.title = "Piste voix (coupée / accélérée)";
    node.append(Object.assign(document.createElement("div"), { className: "clip-label", textContent: "🎙️ Voix" }));
    laneVoice.append(node);
    if (S.detected?.length) {
      for (const range of S.detected) {
        const marker = document.createElement("div");
        marker.style.cssText = `position:absolute;top:0;bottom:0;background:rgba(255,210,90,0.25);border-left:1px solid #ffd25a;border-right:1px solid #ffd25a;left:${px(range.start)}px;width:${Math.max(1, px(range.end - range.start))}px;pointer-events:none;`;
        laneVoice.append(marker);
      }
    }
  }

  // --- pistes audio ---
  laneAudio.innerHTML = "";
  for (const track of S.project?.audioTracks || []) {
    const lane = document.createElement("div");
    lane.className = `lane${track.muted ? " layer-hidden" : ""}`;
    lane.dataset.trackId = track.id;
    lane.dataset.laneKind = "audio";
    styleLane(lane);
    makeGrid(lane, dur);

    for (const clip of track.clips || []) {
      const node = clipEl("audio", track.kind === "sfx" ? "sfx" : "");
      node.dataset.id = clip.id;
      node.style.left = `${px(clip.start)}px`;
      node.style.width = `${Math.max(8, px(clip.duration))}px`;
      const source = sourceById(clip.sourceId);
      addFades(node, clip);
      const gainDb = clip.gain > 0 ? `${Math.round(20 * Math.log10(clip.gain))} dB` : "−∞";
      node.append(
        Object.assign(document.createElement("div"), {
          className: "clip-label",
          textContent: `${source?.name?.slice(0, 28) || "audio"} · ${Math.round(clip.duration * 10) / 10}s · ${gainDb}`,
        })
      );
      addHandles(node, clip, "audio", track.id);
      lane.append(node);
    }
    laneAudio.append(lane);
  }

  // --- textes libres ---
  laneTexts.innerHTML = "";
  const textsLane = document.createElement("div");
  textsLane.className = "lane text-lane";
  textsLane.dataset.laneKind = "text";
  styleLane(textsLane);
  makeGrid(textsLane, dur);
  const texts = (S.project?.texts || []).slice().sort((a, b) => a.start - b.start);
  for (const text of texts) {
    const node = clipEl("text");
    node.dataset.id = text.id;
    const clipWidth = Math.max(8, px(text.duration));
    node.style.left = `${px(text.start)}px`;
    node.style.width = `${clipWidth}px`;
    if (clipWidth < 34) node.classList.add("tiny");
    node.append(
      Object.assign(document.createElement("div"), {
        className: "clip-label",
        textContent: clipWidth < 74 ? "T" : `📝 ${(text.text || "").slice(0, 22)}`,
      })
    );
    node.title = "Double-clic : modifier le texte · glisser = déplacer · le cadre se règle sur l'aperçu";
    node.addEventListener("dblclick", (event) => {
      event.stopPropagation();
      emit("edit-text", { id: text.id });
    });
    if (S.selectedClipIds?.includes(text.id)) node.classList.add("selected");
    addHandles(node, text, "text", null);
    textsLane.append(node);
  }
  laneTexts.append(textsLane);

  // --- colonne des libellés (même ordre que les lanes) ---
  const rows = [
    { text: "Temps", className: "ruler-label" },
    {
      text: "🎬 Vidéo 1",
      count: (S.project?.videoTrack || []).length,
      title: "Piste principale : une seule illustration à la fois, avec transitions",
      controls: [iconButton("＋", "Ajouter une piste vidéo (superpositions)", () => addVideoLayer())],
    },
  ];
  for (const layer of layers) {
    rows.push({
      text: `${layer.hidden ? "🙈" : "🎬"} ${layer.name}`,
      count: layer.clips.length,
      title: "Calque d'incrustation, au-dessus de la piste principale",
      // L'ordre d'empilement se règle depuis le menu 🧩 Panneaux : ici, on garde
      // l'essentiel pour laisser le nom de la piste lisible.
      controls: [
        iconButton(layer.hidden ? "👁" : "🙈", layer.hidden ? "Réafficher à l'export" : "Masquer à l'export", () => toggleVideoLayerHidden(layer.id)),
        iconButton("✏️", "Renommer", (e) => renameInline(e.target.closest(".label-row").querySelector(".label-name"), layer.name, (value) => renameVideoLayer(layer.id, value))),
        iconButton("✕", "Supprimer la piste", () => removeVideoLayer(layer.id)),
      ],
    });
  }
  rows.push({ text: "🎙️ Voix" });
  for (const track of S.project?.audioTracks || []) {
    const info = audioKindInfo(track.kind);
    rows.push({
      text: `${track.muted ? "🔇" : info.icon} ${track.name}`,
      count: track.clips?.length || 0,
      controls: [
        iconButton(track.muted ? "🔇" : "🔊", track.muted ? "Réactiver la piste" : "Couper la piste", () => toggleAudioMute(track.id)),
        iconButton("✏️", "Renommer", (e) => renameInline(e.target.closest(".label-row").querySelector(".label-name"), track.name, (value) => renameAudioTrack(track.id, value))),
        iconButton("✕", "Supprimer la piste", () => removeAudioTrack(track.id)),
      ],
    });
  }
  rows.push({
    text: "📝 Textes",
    count: texts.length,
    title: "Textes libres, indépendants de la voix",
    controls: [iconButton("＋", "Ajouter un texte à la tête de lecture", () => addText({ start: S.playhead }))],
    className: "text-label",
  });
  renderLabels(rows);

  updatePlayhead();
  const info = $("#timelineInfo");
  if (info) {
    const overlayCount = layers.reduce((acc, layer) => acc + layer.clips.length, 0);
    info.textContent = S.build
      ? `${(S.project?.videoTrack || []).length} clips · ${overlayCount} incrustations · ${texts.length} textes`
      : "";
  }
  const count = $("#clipsCount");
  if (count) count.textContent = S.build ? "" : "Enregistre ou importe d'abord une voix";
}

const TRANSITION_ICONS = {
  cut: "",
  "fade-black": "⚫",
  dissolve: "🔀",
  "slide-left": "⬅️",
  "slide-right": "➡️",
  "slide-up": "⬆️",
  "slide-down": "⬇️",
  "zoom-in": "🔍",
};

function addTransitionBadge(node, transition, compact = false) {
  if (!transition || transition.type === "cut" || !transition.duration) return;
  const icon = TRANSITION_ICONS[transition.type] || "🔀";
  node.append(
    Object.assign(document.createElement("div"), {
      className: "trans-badge",
      // Clip étroit : l'icône seule reste lisible.
      textContent: compact ? icon : `${icon} ${transition.duration.toFixed(1)}s`,
      title: `Transition : ${transition.type} (${transition.duration}s)`,
    })
  );
}

function addFades(node, clip) {
  const fades = [
    { d: clip.effect?.fadeIn ?? clip.fadeIn ?? 0, side: "left" },
    { d: clip.effect?.fadeOut ?? clip.fadeOut ?? 0, side: "right" },
  ];
  for (const fade of fades) {
    if (!fade.d || fade.d < 0.05) continue;
    const tri = document.createElement("div");
    tri.className = "fade-tri";
    const cab = Math.min(px(fade.d), px(clip.duration) / 2);
    tri.style.width = `${cab}px`;
    tri.style[fade.side] = "0";
    if (fade.side === "right") tri.style.background = "linear-gradient(270deg, rgba(0,0,0,0.75), transparent)";
    node.append(tri);
  }
}

function addHandles(node, clip, kind, trackId, extra = {}) {
  node.addEventListener("mousedown", (e) => {
    if (e.target.classList.contains("handle")) return;
    startDrag(e, clip, "move", kind, { trackId, limit: kind === "overlay" || kind === "text" ? Math.max(duration(), clip.duration + clip.start) : duration(), ...extra });
  });
  const left = document.createElement("div");
  left.className = "handle left";
  left.addEventListener("mousedown", (e) => startDrag(e, clip, "trim-left", kind, { trackId, limit: clip.start + clip.duration, ...extra }));
  const right = document.createElement("div");
  right.className = "handle right";
  right.addEventListener("mousedown", (e) => startDrag(e, clip, "trim-right", kind, { trackId, limit: Math.max(duration(), clip.start + clip.duration), ...extra }));
  node.append(left, right);
}

export function updatePlayhead() {
  if (!playhead) return;
  const dur = Math.max(duration(), 1);
  playhead.style.left = `${clamp(px(S.playhead), 0, px(dur)) + LABEL_W}px`;
}

export function renderVoiceLaneOnly() {
  renderTimeline();
}
