export const S = {
  project: null,
  build: null,
  setup: null,
  playhead: 0,
  playing: false,
  selection: null, // { start, end } en temps compilé
  pxPerSec: 60,
  scroll: 0,
  selectedClipId: null,
  selectedClipIds: [], // sélection multiple (Ctrl/Maj + clic)
  selectedClipKind: null, // video | audio
  activeWord: null, // { word, start, end, segId }
  search: { query: "", provider: "web", results: [], loading: false, errors: [] },
  transcriptsDirty: false,
  recording: false,
  detected: null, // silences détectés (affichage avant application), temps compilé
};

const handlers = new Map();

export function on(event, fn) {
  if (!handlers.has(event)) handlers.set(event, new Set());
  handlers.get(event).add(fn);
  return () => handlers.get(event).delete(fn);
}

export function emit(event, payload) {
  for (const fn of handlers.get(event) || []) {
    try {
      fn(payload);
    } catch (e) {
      console.error(`Erreur handler ${event}`, e);
    }
  }
}

export function setProject(project) {
  S.project = project;
  S.build = project?.voice?.build || null;
  if (S.build) S.playhead = Math.min(S.playhead, S.build.duration || 0);
  else S.playhead = 0;
  emit("project", project);
}

export function duration() {
  return S.build?.duration || 0;
}

export function clips() {
  return S.project?.videoTrack || [];
}

export function trackById(id) {
  return (S.project?.audioTracks || []).find((t) => t.id === id) || null;
}

export function allAudioClips() {
  const out = [];
  for (const track of S.project?.audioTracks || []) {
    for (const clip of track.clips || []) out.push({ track, clip });
  }
  return out;
}

export function sourceById(id) {
  return (S.project?.sources || []).find((s) => s.id === id) || null;
}

/** Trouve le clip vidéo actif à un instant donné. */
export function clipAt(t) {
  return clips().find((c) => t >= c.start - 0.001 && t <= c.start + c.duration + 0.001) || null;
}
