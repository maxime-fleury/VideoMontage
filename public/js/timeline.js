import { S, duration, emit, on, sourceById } from "./state.js";
import { MIME_DRAG } from "./library.js";
// api importé plus bas via le module partagé pour garder un seul point d'entrée
import { $, clamp, api, toast } from "./api.js";

let ruler, laneVideo, laneVoice, laneAudio, trackLabels, playhead, timelineScroll, timelineEl;
let dragState = null;
let saveTimer = null;

const LANE_H = 36;

export function initTimeline() {
  ruler = $("#ruler");
  laneVideo = $("#laneVideo");
  laneVoice = $("#laneVoice");
  laneAudio = $("#laneAudio");
  trackLabels = $("#trackLabels");
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
  const lanes = document.querySelectorAll(".lane");
  const host = document.querySelector(".lanes");
  if (!host) return;

  const resolveTarget = (event) => {
    const lane = event.target.closest?.(".lane");
    if (!lane) return { target: "video", trackId: null, lane: null };
    if (lane.dataset.trackId) return { target: "audio", trackId: lane.dataset.trackId, lane };
    if (lane.id === "laneVoice") return { target: "voice", trackId: null, lane };
    return { target: "video", trackId: null, lane };
  };

  const clearHighlights = () => {
    for (const lane of document.querySelectorAll(".lane.drop-active")) lane.classList.remove("drop-active");
  };

  // Deux origines possibles : des fichiers du disque, ou un média de la médiathèque.
  const hasFiles = (e) => Boolean(e.dataTransfer?.types?.includes("Files"));
  const hasSource = (e) => Boolean(e.dataTransfer?.types?.includes(MIME_DRAG));

  host.addEventListener("dragover", (e) => {
    if (!hasFiles(e) && !hasSource(e)) return;
    e.preventDefault();
    if (hasSource(e)) e.dataTransfer.dropEffect = "copy";
    clearHighlights();
    const { lane } = resolveTarget(e);
    if (lane) lane.classList.add("drop-active");
  });
  host.addEventListener("dragleave", clearHighlights);
  host.addEventListener("drop", (e) => {
    if (!hasFiles(e) && !hasSource(e)) return;
    e.preventDefault();
    clearHighlights();
    const { target, trackId, lane } = resolveTarget(e);
    const time = lane ? timeAt(e, lane) : S.playhead;
    if (hasSource(e)) {
      const sourceId = e.dataTransfer.getData(MIME_DRAG);
      if (sourceId) emit("library-add", { sourceId, time, target, trackId });
      return;
    }
    if (!e.dataTransfer?.files?.length) return;
    emit("drop-media", { files: [...e.dataTransfer.files], time, target, trackId });
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

function startDrag(e, clip, mode, kind, trackId) {
  e.stopPropagation();
  dragState = {
    clip,
    mode, // move | trim-left | trim-right
    kind,
    trackId,
    startX: e.clientX,
    orig: { start: clip.start, duration: clip.duration, offset: clip.offset },
  };
  if (!S.selectedClipIds.includes(clip.id)) selectClip(clip.id, kind, e.ctrlKey || e.metaKey || e.shiftKey);
  window.addEventListener("mousemove", onDragMove);
  window.addEventListener("mouseup", onDragEnd);
}

function onDragMove(e) {
  if (!dragState) return;
  const { clip, mode, orig } = dragState;
  const delta = (e.clientX - dragState.startX) / S.pxPerSec;
  if (mode === "move") {
    clip.start = Math.max(0, Math.min(duration() - 0.2, orig.start + delta));
  } else if (mode === "trim-left") {
    const newStart = clamp(orig.start + delta, Math.max(0, orig.start - orig.offset), orig.start + orig.duration - 0.2);
    clip.start = newStart;
    clip.duration = orig.duration - (newStart - orig.start);
    clip.offset = Math.max(0, orig.offset + (newStart - orig.start));
  } else {
    clip.duration = Math.max(0.2, Math.min(orig.duration + delta, duration() - clip.start, 600));
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
        body: { videoTrack: S.project.videoTrack, audioTracks: S.project.audioTracks },
      });
      S.project = project;
      emit("saved");
    } catch (e) {
      toast(`Sauvegarde impossible : ${e.message}`, "error");
    }
  }, 260);
}

export function renderTimeline() {
  if (!timelineEl) return;
  const dur = Math.max(duration(), 1);
  renderRuler();

  const width = Math.max(dur * S.pxPerSec, 400);
  timelineEl.style.width = `${width + 110}px`;

  // --- piste vidéo ---
  laneVideo.innerHTML = "";
  styleLane(laneVideo);
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

  // --- piste voix ---
  laneVoice.innerHTML = "";
  styleLane(laneVoice);
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
  trackLabels.innerHTML = "";
  (S.project?.audioTracks || []).forEach((track) => {
    const label = document.createElement("div");
    label.className = "label-row";
    label.innerHTML = `<span>${track.kind === "music" ? "🎵" : track.kind === "sfx" ? "💥" : "🔊"} ${track.name}</span>`;
    trackLabels.append(label);

    const lane = document.createElement("div");
    lane.className = "lane";
    lane.dataset.trackId = track.id;
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
  });

  updatePlayhead();
  const info = $("#timelineInfo");
  if (info) info.textContent = S.build ? `${(S.project?.videoTrack || []).length} clips · ${dur.toFixed(1)} s` : "";
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

function addHandles(node, clip, kind, trackId) {
  node.addEventListener("mousedown", (e) => {
    if (e.target.classList.contains("handle")) return;
    startDrag(e, clip, "move", kind, trackId);
  });
  const left = document.createElement("div");
  left.className = "handle left";
  left.addEventListener("mousedown", (e) => startDrag(e, clip, "trim-left", kind, trackId));
  const right = document.createElement("div");
  right.className = "handle right";
  right.addEventListener("mousedown", (e) => startDrag(e, clip, "trim-right", kind, trackId));
  node.append(left, right);
}

export function updatePlayhead() {
  if (!playhead) return;
  const dur = Math.max(duration(), 1);
  playhead.style.left = `${clamp(px(S.playhead), 0, px(dur)) + 110}px`;
}

export function renderVoiceLaneOnly() {
  renderTimeline();
}
