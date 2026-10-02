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
  selectedClipKind: null, // video | overlay | text | audio
  selectedTextId: null, // texte sélectionné sur l'aperçu
  motions: null, // catalogue des placements/mouvements (GET /api/motions)
  showOverlays: true, // incrustations et textes visibles dans l'aperçu
  showMotionPath: true, // tracé du déplacement des images clés dans l'aperçu
  overlayPathClipId: null, // incrustation dont on dessine le tracé (éditée ou sélectionnée)
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

/**
 * Fusionne un projet reçu du serveur dans le projet courant en conservant
 * l'identité des objets déjà connus (clips, pistes, calques, textes, styles).
 *
 * Sans cela, chaque sauvegarde remplacerait les objets : un éditeur ouvert ou
 * une poignée de glissement pointerait alors sur une ancienne copie et les
 * modifications suivantes seraient perdues.
 */
export function adoptProject(project) {
  if (!project) return S.project;
  S.project = S.project && S.project.id === project.id ? reconcile(S.project, project) : project;
  return S.project;
}

export function reconcile(previous, next) {
  if (Array.isArray(previous) && Array.isArray(next)) {
    const byId = new Map();
    for (const item of previous) {
      if (item && typeof item === "object" && item.id) byId.set(item.id, item);
    }
    return next.map((item) => {
      if (item && typeof item === "object" && item.id && byId.has(item.id)) {
        return reconcile(byId.get(item.id), item);
      }
      return item;
    });
  }
  if (previous && next && typeof previous === "object" && typeof next === "object") {
    for (const key of Object.keys(next)) previous[key] = reconcile(previous[key], next[key]);
    return previous;
  }
  return next;
}

export function setProject(project) {
  adoptProject(project);
  S.build = project?.voice?.build || null;
  if (S.build) S.playhead = Math.min(S.playhead, S.build.duration || 0);
  else S.playhead = 0;
  emit("project", S.project);
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
