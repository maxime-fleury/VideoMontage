import { S, duration, emit } from "./state.js";
import { toast } from "./api.js";

/**
 * Gestion des pistes : audio, calques vidéo (superpositions) et textes libres.
 * Le même code sert au menu « 🧩 Panneaux » et aux commandes de la timeline.
 */

export const AUDIO_KINDS = [
  { id: "music", label: "Musique", icon: "🎵" },
  { id: "sfx", label: "Bruitage", icon: "💥" },
  { id: "other", label: "Ambiance", icon: "🔊" },
];

export const MAX_OVERLAY_LAYERS = 3;

const newId = (prefix) => `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
export const timelineEnd = () => Math.max(duration(), 1);

function commit(message) {
  emit("persist");
  emit("render");
  if (message) toast(message, "ok", 2600);
}

export function audioKindInfo(kind) {
  return AUDIO_KINDS.find((k) => k.id === kind) || AUDIO_KINDS[0];
}

// ---------------------------------------------------------------------------
// Pistes audio
// ---------------------------------------------------------------------------
export function addAudioTrack(kind = "music") {
  if (!S.project) return null;
  S.project.audioTracks = S.project.audioTracks || [];
  const info = audioKindInfo(kind);
  const track = {
    id: newId("trk"),
    name: `${info.label} ${S.project.audioTracks.filter((t) => t.kind === kind).length + 1}`,
    kind,
    muted: false,
    clips: [],
  };
  S.project.audioTracks.push(track);
  commit(`Piste « ${track.name} » ajoutée`);
  return track;
}

export function removeAudioTrack(trackId, { ask = true } = {}) {
  const track = (S.project?.audioTracks || []).find((t) => t.id === trackId);
  if (!track) return false;
  if (ask && track.clips?.length && !confirm(`Supprimer la piste « ${track.name} » et ses ${track.clips.length} sons ?`)) return false;
  S.project.audioTracks = S.project.audioTracks.filter((t) => t.id !== trackId);
  commit(`Piste « ${track.name} » supprimée`);
  return true;
}

export function renameAudioTrack(trackId, name) {
  const track = (S.project?.audioTracks || []).find((t) => t.id === trackId);
  if (!track) return;
  track.name = String(name || track.name).slice(0, 60);
  commit();
}

export function toggleAudioMute(trackId) {
  const track = (S.project?.audioTracks || []).find((t) => t.id === trackId);
  if (!track) return;
  track.muted = !track.muted;
  commit(track.muted ? `« ${track.name} » coupée` : `« ${track.name} » réactivée`);
}

// ---------------------------------------------------------------------------
// Calques vidéo (superpositions)
// ---------------------------------------------------------------------------
export function addVideoLayer() {
  if (!S.project) return null;
  S.project.overlayLayers = S.project.overlayLayers || [];
  if (S.project.overlayLayers.length >= MAX_OVERLAY_LAYERS) {
    toast(`${MAX_OVERLAY_LAYERS} pistes vidéo maximum`, "error");
    return null;
  }
  const layer = {
    id: newId("lyr"),
    name: `Vidéo ${S.project.overlayLayers.length + 2}`,
    hidden: false,
    clips: [],
  };
  S.project.overlayLayers.push(layer);
  commit(`Piste « ${layer.name} » ajoutée — dépose une image ou une vidéo dessus`);
  return layer;
}

export function removeVideoLayer(layerId, { ask = true } = {}) {
  const layer = (S.project?.overlayLayers || []).find((l) => l.id === layerId);
  if (!layer) return false;
  if (ask && layer.clips?.length && !confirm(`Supprimer la piste « ${layer.name} » et ses ${layer.clips.length} incrustations ?`)) return false;
  S.project.overlayLayers = S.project.overlayLayers.filter((l) => l.id !== layerId);
  commit(`Piste « ${layer.name} » supprimée`);
  return true;
}

export function renameVideoLayer(layerId, name) {
  const layer = (S.project?.overlayLayers || []).find((l) => l.id === layerId);
  if (!layer) return;
  layer.name = String(name || layer.name).slice(0, 60);
  commit();
}

export function toggleVideoLayerHidden(layerId) {
  const layer = (S.project?.overlayLayers || []).find((l) => l.id === layerId);
  if (!layer) return;
  layer.hidden = !layer.hidden;
  commit(layer.hidden ? `« ${layer.name} » masquée à l'export` : `« ${layer.name} » réaffichée`);
}

/** Ordre d'empilement : -1 = descend d'un cran, +1 = monte d'un cran. */
export function moveVideoLayer(layerId, delta) {
  const layers = S.project?.overlayLayers || [];
  const index = layers.findIndex((l) => l.id === layerId);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= layers.length) return;
  const [layer] = layers.splice(index, 1);
  layers.splice(target, 0, layer);
  commit("Ordre des calques modifié");
}

export function videoLayerById(layerId) {
  return (S.project?.overlayLayers || []).find((l) => l.id === layerId) || null;
}

// ---------------------------------------------------------------------------
// Incrustations
// ---------------------------------------------------------------------------
export function addOverlayClip(layerId, source, time, extra = {}) {
  const layer = videoLayerById(layerId);
  if (!layer || !source) return null;
  const maxDuration = source.kind === "video" ? Math.max(0.5, source.duration || 4) : 5;
  const clipDuration = Math.max(0.5, Math.min(extra.duration || 4, maxDuration));
  const clip = {
    id: newId("ovl"),
    sourceId: source.id,
    start: Math.max(0, Math.min(Number(time) || 0, timelineEnd())),
    duration: clipDuration,
    offset: 0,
    box: extra.box || { x: 0.62, y: 0.6, w: 0.34, h: 0.34 },
    fit: source.kind === "image" && source.meta?.transparent ? "contain" : "cover",
    opacity: 1,
    rotation: 0,
    motion: extra.motion || { preset: "pip-corner", amount: 0.5 },
    fadeIn: 0.25,
    fadeOut: 0.25,
    audio: { mute: true, gain: 1 },
    createdAt: Date.now(),
  };
  layer.clips.push(clip);
  layer.clips.sort((a, b) => a.start - b.start);
  commit(`Incrustation ajoutée sur « ${layer.name} »`);
  return clip;
}

export function removeOverlayClip(layerId, clipId, { ask = false } = {}) {
  const layer = videoLayerById(layerId);
  if (!layer) return false;
  if (ask && !confirm("Supprimer cette incrustation ?")) return false;
  layer.clips = layer.clips.filter((c) => c.id !== clipId);
  commit("Incrustation supprimée");
  return true;
}

export function findOverlayClip(clipId) {
  for (const layer of S.project?.overlayLayers || []) {
    const clip = layer.clips.find((c) => c.id === clipId);
    if (clip) return { layer, clip };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Textes libres
// ---------------------------------------------------------------------------
export function addText(overrides = {}) {
  if (!S.project) return null;
  S.project.texts = S.project.texts || [];
  const maxZ = S.project.texts.reduce((acc, t) => Math.max(acc, t.z || 0), 0);
  const text = {
    id: newId("txt"),
    text: overrides.text ?? "Ton texte",
    start: Math.max(0, Number.isFinite(overrides.start) ? Number(overrides.start) : S.playhead || 0),
    duration: overrides.duration ?? 3,
    box: overrides.box || { x: 0.15, y: 0.22, w: 0.7, h: 0.12 },
    rotation: 0,
    z: maxZ + 1,
    style: {
      font: "Outfit",
      size: 0.075,
      bold: true,
      italic: false,
      color: "#ffffff",
      highlightColor: "#ffd166",
      outlineColor: "#1a1030",
      outlineWidth: 4,
      shadow: 8,
      background: "",
      padding: 14,
      uppercase: false,
      letterSpacing: 0,
      lineHeight: 1.15,
      align: "center",
    },
    animation: { in: "pop", out: "fade", duration: 0.35 },
    createdAt: Date.now(),
  };
  Object.assign(text, overrides, { style: { ...text.style, ...(overrides.style || {}) } });
  S.project.texts.push(text);
  commit("Texte ajouté — déplace-le directement sur l'aperçu");
  return text;
}

export function removeText(id, { ask = false } = {}) {
  if (ask && !confirm("Supprimer ce texte ?")) return false;
  S.project.texts = (S.project.texts || []).filter((t) => t.id !== id);
  commit("Texte supprimé");
  return true;
}

export function textById(id) {
  return (S.project?.texts || []).find((t) => t.id === id) || null;
}

export function moveTextLayer(id, delta) {
  const texts = S.project?.texts || [];
  const text = texts.find((t) => t.id === id);
  if (!text) return;
  text.z = (text.z || 0) + delta;
  commit();
}

/** Fin de la dernière incrustation / texte (pour connaître la portée du montage). */
export function overlaysEnd() {
  let end = 0;
  for (const layer of S.project?.overlayLayers || []) {
    for (const clip of layer.clips) end = Math.max(end, clip.start + clip.duration);
  }
  for (const text of S.project?.texts || []) end = Math.max(end, text.start + text.duration);
  return end;
}
