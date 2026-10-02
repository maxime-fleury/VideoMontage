import { S, on, emit, duration } from "./state.js";
import { $, el, api, toast, openModal, fmtTime, clamp, newId, defaultClipEffect } from "./api.js";

const MIME_DRAG = "application/x-montage-source";
let host = null;
let info = null;
let signature = "";

/** Nombre de fois où une source est utilisée dans le montage. */
function usageCount(sourceId) {
  const video = (S.project?.videoTrack || []).filter((c) => c.sourceId === sourceId).length;
  const audio = (S.project?.audioTracks || []).reduce(
    (n, track) => n + track.clips.filter((c) => c.sourceId === sourceId).length,
    0
  );
  return video + audio;
}

function kindLabel(source) {
  if (source.kind === "image") return "image";
  if (source.kind === "video") return "vidéo";
  return "audio";
}

function metaLine(source) {
  const parts = [kindLabel(source)];
  if (source.kind === "image" && source.width) parts.push(`${source.width}×${source.height}`);
  if (source.kind !== "image" && source.duration) parts.push(fmtTime(source.duration));
  const used = usageCount(source.id);
  if (used) parts.push(`utilisé ${used}×`);
  return parts.join(" · ");
}

/** Vignette : image directe, première image pour une vidéo, icône pour l'audio. */
function thumb(source) {
  const box = el("div", { class: "media-thumb" });
  if (source.kind === "audio") {
    box.append(el("div", { class: "media-icon", text: "🎵" }));
    return box;
  }
  if (source.kind === "video") {
    const video = el("video", { src: `${source.url}#t=0.1`, muted: true, preload: "metadata", playsinline: true });
    box.append(video, el("span", { class: "media-badge", text: "🎬" }));
    return box;
  }
  box.append(el("img", { src: source.url, loading: "lazy", alt: source.name }));
  return box;
}

function addSourceToTimeline(source, time, target = "video", trackId = null) {
  if (!source) return null;
  const at = Math.max(0, Number(time) || 0);
  if (source.kind === "audio") {
    let track = S.project.audioTracks.find((t) => t.id === trackId) || S.project.audioTracks[0];
    if (!track) {
      track = { id: newId("trk"), name: "Piste 1", kind: "music", muted: false, clips: [] };
      S.project.audioTracks.push(track);
    }
    track.clips.push({
      id: newId("clip"),
      sourceId: source.id,
      start: at,
      duration: Math.max(0.5, source.duration || 3),
      offset: 0,
      gain: 0.6,
      fadeIn: 0.3,
      fadeOut: 0.6,
    });
    emit("persist");
    emit("render");
    toast(`« ${source.name} » posé sur ${track.name} à ${fmtTime(at)}`, "ok");
    return track;
  }
  const clip = {
    id: newId("clip"),
    sourceId: source.id,
    keyword: source.meta?.keyword || source.name.replace(/\.[a-z0-9]+$/i, "").slice(0, 40),
    start: at,
    duration: source.kind === "video" ? clamp(source.duration || 4, 1, 20) : 3,
    offset: 0,
    effect: defaultClipEffect(),
    createdAt: Date.now(),
  };
  S.project.videoTrack.push(clip);
  S.project.videoTrack.sort((a, b) => a.start - b.start);
  emit("persist");
  emit("render");
  emit("selection-clip", { id: clip.id, kind: "video", ids: [clip.id] });
  toast(`« ${source.name} » ajouté à ${fmtTime(at)}`, "ok");
  return clip;
}

/** Aperçu d'un média du projet (image / vidéo / audio). */
export function openSourcePreview(sourceId) {
  const source = S.project?.sources?.find((s) => s.id === sourceId);
  if (!source) return;
  let media;
  if (source.kind === "image") media = el("img", { src: source.url, class: "preview-media" });
  else if (source.kind === "video") media = el("video", { src: source.url, controls: true, class: "preview-media" });
  else media = el("audio", { src: source.url, controls: true });

  const status = el("div", { class: "muted", style: { fontSize: "12px" } });
  const modal = el("div", {}, [
    el("h2", { text: `👁️ ${source.name}` }),
    el("div", { class: "muted", style: { fontSize: "12px", marginBottom: "10px" }, text: metaLine(source) }),
    media,
    status,
    el("div", { class: "footer" }, [
      el("button", {
        text: "＋ Ajouter à la tête de lecture",
        onclick: () => {
          addSourceToTimeline(source, S.playhead);
          close?.();
        },
      }),
      el("button", { class: "primary", text: "＋ À la fin du montage", onclick: () => {
        addSourceToTimeline(source, Math.max(0, duration()));
        close?.();
      } }),
      el("button", { text: "Fermer", onclick: () => close?.() }),
    ]),
  ]);
  const close = openModal(() => modal);
}

async function removeSource(source) {
  if (!confirm(`Supprimer « ${source.name} » du projet ?`)) return;
  try {
    const { project } = await api(`/api/projects/${S.project.id}/sources/${source.id}`, { method: "DELETE" });
    S.project = project;
    emit("project-external", project);
    toast("Média supprimé", "ok");
  } catch (e) {
    toast(`Suppression impossible : ${e.message}`, "error");
  }
}

function mediaItem(source) {
  const item = el("div", {
    class: "media-item",
    draggable: "true",
    title: `${source.name}\nGlisse sur la timeline (ou double-clic pour l'aperçu)`,
    ondblclick: () => openSourcePreview(source.id),
  });
  item.dataset.id = source.id;
  const used = usageCount(source.id);
  if (used) item.classList.add("used");

  item.append(
    thumb(source),
    el("div", { class: "media-body" }, [
      el("div", { class: "media-name", text: source.name }),
      el("div", { class: "media-meta", text: metaLine(source) }),
    ]),
    el("div", { class: "media-actions" }, [
      el("button", {
        class: "ghost icon",
        title: "Aperçu",
        text: "👁",
        onclick: (e) => {
          e.stopPropagation();
          openSourcePreview(source.id);
        },
      }),
      el("button", {
        class: "ghost icon",
        title: "Ajouter à la tête de lecture",
        text: "＋",
        onclick: (e) => {
          e.stopPropagation();
          addSourceToTimeline(source, S.playhead);
        },
      }),
      el("button", {
        class: "ghost icon",
        title: "Supprimer du projet",
        text: "✕",
        onclick: (e) => {
          e.stopPropagation();
          removeSource(source);
        },
      }),
    ])
  );

  item.addEventListener("dragstart", (e) => {
    e.dataTransfer.effectAllowed = "copy";
    e.dataTransfer.setData(MIME_DRAG, source.id);
    e.dataTransfer.setData("text/plain", source.name);
    item.classList.add("dragging");
  });
  item.addEventListener("dragend", () => item.classList.remove("dragging"));
  return item;
}

export function renderLibrary() {
  if (!host) return;
  const sources = S.project?.sources || [];
  const nextSignature = sources.map((s) => `${s.id}:${usageCount(s.id)}`).join("|");
  if (nextSignature === signature) return;
  signature = nextSignature;

  host.innerHTML = "";
  if (info) info.textContent = `${sources.length} média${sources.length > 1 ? "s" : ""}`;

  const drop = el("div", {
    class: "media-drop",
    html: "⬇️ Dépose ici tes images, vidéos ou sons<br><span class=\"muted\">ils rejoignent la médiathèque du projet</span>",
  });
  host.append(drop);

  if (!sources.length) {
    host.append(el("div", { class: "muted", style: { fontSize: "12px", padding: "8px 2px" }, text: "Aucun média pour l'instant." }));
    return;
  }

  const grid = el("div", { class: "media-grid" });
  const sorted = [...sources].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  for (const source of sorted) grid.append(mediaItem(source));
  host.append(grid);
}

export function initLibrary() {
  host = $("#library");
  info = $("#libraryInfo");
  if (!host) return;
  const card = host.closest(".card");
  if (card) {
    card.addEventListener("dragover", (e) => {
      if (!e.dataTransfer?.types?.includes("Files")) return;
      e.preventDefault();
      card.classList.add("drop-target");
    });
    card.addEventListener("dragleave", () => card.classList.remove("drop-target"));
    card.addEventListener("drop", (e) => {
      if (!e.dataTransfer?.files?.length) return;
      e.preventDefault();
      card.classList.remove("drop-target");
      emit("drop-media", { files: [...e.dataTransfer.files], time: S.playhead, target: "video", trackId: null });
    });
  }
  // dépôt depuis la médiathèque vers la timeline (ou tout autre émetteur)
  on("library-add", ({ sourceId, time, target, trackId }) => {
    const source = S.project?.sources?.find((s) => s.id === sourceId);
    if (source) addSourceToTimeline(source, time, target, trackId);
  });
  on("project", () => {
    signature = "";
    renderLibrary();
  });
  on("project-external", () => {
    signature = "";
    renderLibrary();
  });
  // les badges « utilisé N× » suivent l'état du montage (re-rendu seulement si ça change)
  on("render", renderLibrary);
  renderLibrary();
}

export { MIME_DRAG };
