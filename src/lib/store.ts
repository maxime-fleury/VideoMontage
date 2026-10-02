import fs from "node:fs/promises";
import { DATA_DIR, MODELS_DIR, PROJECTS_DIR, TOOLS_DIR, clamp, mediaDir, newId, projectDir, writeJson, readJson, buildDir } from "./util";
import { defaultSubtitles } from "./subtitles";

export type SourceKind = "audio" | "video" | "image";

export type Source = {
  id: string;
  kind: SourceKind;
  name: string;
  file: string; // nom de fichier dans media/
  duration: number; // secondes (0 pour image)
  sampleRate?: number;
  channels?: number;
  width?: number;
  height?: number;
  fps?: number;
  origin: "record" | "upload" | "search" | "url";
  /** clé chromatique (fond vert/bleu) : s'applique au média partout où il est incrusté */
  chroma?: Chroma;
  meta?: Record<string, unknown>;
  createdAt: number;
};

/**
 * Clé chromatique : rend transparente une couleur de fond (vert, bleu…).
 * `similarity` = largeur de la plage de couleurs écartée, `blend` = douceur du
 * bord, `despill` = retrait du reflet coloré qui reste sur les contours.
 */
export type Chroma = {
  enabled: boolean;
  /** couleur écran, en hexadécimal #rrggbb */
  color: string;
  similarity: number; // 0..1
  blend: number; // 0..1
  despill: boolean;
};

export function defaultChroma(over: Partial<Chroma> = {}): Chroma {
  return { enabled: false, color: "#00ff00", similarity: 0.3, blend: 0.1, despill: true, ...over };
}

/**
 * Image clé d'une incrustation : un état complet à un instant local du clip.
 * Deux images clés suffisent à décrire « ce mouvement-là », et on peut en poser
 * davantage pour un trajet en zigzag.
 */
export type Keyframe = {
  t: number; // secondes depuis le début de l'incrustation
  box: Box;
  rotation: number;
  opacity: number;
};

export type Range = { start: number; end: number };

export type DenoiseMode = "none" | "auto" | "profile" | "rnnoise";

export type Denoise = {
  mode: DenoiseMode;
  /** réduction en dB (afftdn nr) */
  reduction: number;
  /** plancher de bruit mesuré en dB (mode profile) */
  floorDb?: number;
  /** modèle RNNoise utilisé (mode rnnoise) */
  model?: string;
  /** zone blanche choisie par l'utilisateur, en temps source */
  sample?: Range;
};

export type VoiceEdits = {
  /** zones supprimées définitivement (temps source) */
  cuts: Range[];
  /** zones accélérées x factor (temps source) */
  ffwd: Range[];
  ffwdFactor: number;
  denoise: Denoise;
  /** normalisation EBU R128 à la compilation */
  normalize: boolean;
};

export type Segment = {
  srcStart: number;
  srcEnd: number;
  tempo: number;
  outStart: number;
  outEnd: number;
};

export type VoiceBuild = {
  sourceId: string;
  duration: number; // durée compilée (timeline montage)
  segments: Segment[];
  peaks: number[]; // min/max entrelacés, -1..1
  peaksBuckets: number;
  audioFile: string; // mp3 de prévisualisation (relatif à build/)
  wavFile: string; // wav 16k mono pour whisper
  stats: { meanDb: number; peakDb: number };
  builtAt: number;
  hash: string;
};

export type Word = {
  w: string;
  s: number;
  e: number;
  /** mot corrigé à la main (repère visuel dans la transcription) */
  edited?: boolean;
};

export type TranscriptSegment = {
  id: string;
  start: number;
  end: number;
  text: string;
  words: Word[];
};

export type Transcript = {
  language: string;
  model: string;
  segments: TranscriptSegment[];
  builtAt: number;
  hash: string; // hash du build utilisé
};

export type TransitionType =
  | "cut"
  | "fade-black"
  | "dissolve"
  | "slide-left"
  | "slide-right"
  | "slide-up"
  | "slide-down"
  | "zoom-in";

export type Transition = { type: TransitionType; duration: number };

export type ClipEffect = {
  fadeIn: number;
  fadeOut: number;
  kenBurns: boolean;
  zoomFrom: number;
  zoomTo: number;
  transition: Transition;
};

export type SubtitlePreset = "classique" | "karaoke" | "lyrics" | "neon" | "minimal";

export type Subtitles = {
  enabled: boolean;
  preset: SubtitlePreset | string;
  font: string;
  fontSize: number;
  textColor: string;
  highlightColor: string;
  outlineColor: string;
  outlineWidth: number;
  position: "bottom" | "middle" | "top";
  animation: "none" | "fade" | "pop" | "slide";
  uppercase: boolean;
  background: boolean;
  karaoke: boolean;
  maxWordsPerLine: number;
  marginBottom: number;
};

export type VideoClip = {
  id: string;
  sourceId: string;
  keyword?: string;
  start: number; // timeline
  duration: number;
  offset: number; // dans la source (vidéo)
  effect: ClipEffect;
  /** si true, la musique continuera sous ce clip */
  createdAt: number;
};

export type AudioClip = {
  id: string;
  sourceId: string;
  start: number;
  duration: number;
  offset: number;
  gain: number;
  fadeIn: number;
  fadeOut: number;
  loop?: boolean;
};

export type AudioTrack = {
  id: string;
  name: string;
  kind: "music" | "sfx" | "voice" | "other";
  muted: boolean;
  clips: AudioClip[];
};

// ---------------------------------------------------------------------------
// Superpositions : calques vidéo/image au-dessus de la piste principale
// ---------------------------------------------------------------------------

/** Mouvements prédéfinis applicables à une incrustation (voir lib/motions.ts). */
export type MotionPresetId =
  | "none"
  | "pip-static"
  | "pip-corner"
  | "drift-left"
  | "drift-right"
  | "drift-up"
  | "drift-down"
  | "zoom-in"
  | "zoom-out"
  | "pop"
  | "slide-in-left"
  | "slide-in-right"
  | "slide-in-top"
  | "slide-in-bottom";

/**
 * Cadre d'une incrustation, exprimé en fractions 0..1 du cadre de sortie.
 * Le même modèle sert à l'aperçu (pourcentages CSS) et au rendu (ffmpeg), ce qui
 * garantit que ce que tu déplaces à la souris est ce qui est exporté.
 */
export type Box = { x: number; y: number; w: number; h: number };

export type Motion = {
  preset: MotionPresetId;
  /** intensité 0..1 (dérive, zoom) */
  amount: number;
};

export type OverlayClip = {
  id: string;
  sourceId: string;
  start: number; // timeline
  duration: number;
  offset: number; // dans la source (vidéo)
  box: Box;
  /** contain = entier visible (logos), cover = remplit le cadre (recadre) */
  fit: "cover" | "contain";
  opacity: number;
  rotation: number;
  motion: Motion;
  fadeIn: number;
  fadeOut: number;
  /**
   * Images clés (facultatif) : quand il y en a, elles remplacent le mouvement
   * prédéfini et décrivent position, taille, rotation et opacité à chaque instant.
   */
  keys?: Keyframe[];
  /** courbe d'interpolation entre deux images clés */
  ease?: "linear" | "smooth";
  /** bande son de la vidéo incrustée (coupée par défaut) */
  audio: { mute: boolean; gain: number };
  createdAt: number;
};

export type OverlayLayer = {
  id: string;
  name: string;
  hidden: boolean;
  clips: OverlayClip[];
};

// ---------------------------------------------------------------------------
// Textes libres (indépendants de la voix)
// ---------------------------------------------------------------------------

export type TextStyle = {
  font: string;
  /** taille en fraction de la hauteur (0.06 ≈ 65 px en 1080p) */
  size: number;
  bold: boolean;
  italic: boolean;
  color: string;
  /** couleur de surlignage (animation « mot par mot ») */
  highlightColor: string;
  outlineColor: string;
  /** épaisseur du contour en px à 1080p */
  outlineWidth: number;
  /** ombre portée en px à 1080p (0 = aucune) */
  shadow: number;
  /** pastille de fond ("" = aucune) */
  background: string;
  padding: number;
  uppercase: boolean;
  letterSpacing: number;
  lineHeight: number;
  align: "left" | "center" | "right";
};

export type TextAnimationIn =
  | "none"
  | "fade"
  | "pop"
  | "slide-up"
  | "slide-down"
  | "slide-left"
  | "slide-right"
  | "typewriter"
  | "word-highlight";
export type TextAnimationOut = "none" | "fade" | "pop" | "slide";

export type TextOverlay = {
  id: string;
  text: string;
  start: number;
  duration: number;
  /** centre du bloc en fractions 0..1 du cadre (w/h = taille de référence du bloc) */
  box: Box;
  rotation: number;
  z: number;
  style: TextStyle;
  animation: { in: TextAnimationIn; out: TextAnimationOut; duration: number };
  createdAt: number;
};

/** Progression du pilote « montage auto complet » (points de contrôle). */
export type AutoStepId = "silences" | "transcription" | "keywords" | "illustrations" | "subtitles" | "export";

export type AutoState = {
  jobId?: string;
  stage?: AutoStepId;
  completed: AutoStepId[];
  options?: Record<string, unknown>;
  report?: string[];
  updatedAt: number;
};

export type Project = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  sources: Source[];
  voice: {
    sourceId?: string;
    edits: VoiceEdits;
    build?: VoiceBuild;
  };
  transcript?: Transcript;
  videoTrack: VideoClip[];
  audioTracks: AudioTrack[];
  /** calques d'incrustation au-dessus de la piste principale (Vidéo 2, 3…) */
  overlayLayers: OverlayLayer[];
  /** textes libres, indépendants de la voix */
  texts: TextOverlay[];
  auto?: AutoState;
  subtitles?: Subtitles;
  output: {
    width: number;
    height: number;
    fps: number;
    normalize: boolean;
    crf: number;
  };
};

export function defaultEffect(): ClipEffect {
  return {
    fadeIn: 0.4,
    fadeOut: 0.4,
    kenBurns: false,
    zoomFrom: 1,
    zoomTo: 1.12,
    transition: { type: "fade-black", duration: 0.5 },
  };
}

export function defaultBox(): Box {
  // PiP au coin inférieur droit, avec une petite marge.
  return { x: 0.6, y: 0.6, w: 0.34, h: 0.34 };
}

export function defaultMotion(): Motion {
  return { preset: "pip-corner", amount: 0.5 };
}

export function defaultTextStyle(): TextStyle {
  return {
    font: "Outfit",
    size: 0.07,
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
  };
}

export function defaultTextAnimation(): TextOverlay["animation"] {
  return { in: "pop", out: "fade", duration: 0.35 };
}

export function defaultTextBox(): Box {
  // Bandeau centré horizontalement (coin haut-gauche + taille, comme les incrustations).
  return { x: 0.15, y: 0.22, w: 0.7, h: 0.12 };
}

export function defaultEdits(): VoiceEdits {
  return {
    cuts: [],
    ffwd: [],
    ffwdFactor: 100,
    denoise: { mode: "none", reduction: 12 },
    normalize: false,
  };
}

export function projectPath(pid: string) {
  return `${projectDir(pid)}/project.json`;
}

export async function initStorage() {
  await fs.mkdir(PROJECTS_DIR, { recursive: true });
  await fs.mkdir(MODELS_DIR, { recursive: true });
  await fs.mkdir(TOOLS_DIR, { recursive: true });
  await fs.mkdir(`${DATA_DIR}/cache`, { recursive: true });
}

export async function listProjects() {
  await initStorage();
  const entries = await fs.readdir(PROJECTS_DIR, { withFileTypes: true });
  const projects: Project[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const p = await readJson<Project>(projectPath(entry.name));
    if (p) projects.push(p);
  }
  return projects.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function createProject(name: string): Promise<Project> {
  await initStorage();
  const id = newId("prj");
  const project: Project = {
    id,
    name: name || "Nouveau montage",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sources: [],
    voice: { edits: defaultEdits() },
    videoTrack: [],
    audioTracks: [
      { id: newId("trk"), name: "Musique", kind: "music", muted: false, clips: [] },
      { id: newId("trk"), name: "Bruitages", kind: "sfx", muted: false, clips: [] },
    ],
    overlayLayers: [],
    texts: [],
    output: { width: 1920, height: 1080, fps: 30, normalize: true, crf: 20 },
  };
  await ensureProjectDirs(id);
  await saveProject(project);
  return project;
}

export async function ensureProjectDirs(pid: string) {
  await fs.mkdir(projectDir(pid), { recursive: true });
  await fs.mkdir(mediaDir(pid), { recursive: true });
  await fs.mkdir(buildDir(pid), { recursive: true });
}

/**
 * Nettoie les caractères parasites (U+FFFD d'un encodage cassé, contrôles, BOM) dans
 * tout le projet au chargement: plus aucun « h�tel » affiché, y compris dans les
 * données déjà enregistrées. Les espaces et retours à la ligne sont préservés.
 */
function cleanDeep<T>(value: T): T {
  if (typeof value === "string") {
    return value.replace(/[\uFFFD\u0000-\u0008\u000B\u000C\u000E-\u001F\uFEFF\u200B]/g, "") as unknown as T;
  }
  if (Array.isArray(value)) return value.map(cleanDeep) as unknown as T;
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) {
      (value as Record<string, unknown>)[key] = cleanDeep((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

export async function getProject(pid: string): Promise<Project | null> {
  const p = cleanDeep(await readJson<Project>(projectPath(pid)));
  if (!p) return null;
  // Compatibilité / défauts
  p.sources = (p.sources || []).map((source) =>
    source.chroma ? { ...source, chroma: defaultChroma(source.chroma) } : source
  );
  p.voice = p.voice || { edits: defaultEdits() };
  p.voice.edits = { ...defaultEdits(), ...p.voice.edits, denoise: { ...defaultEdits().denoise, ...p.voice.edits?.denoise } };
  p.videoTrack = (p.videoTrack || []).map((clip) => ({
    ...clip,
    effect: { ...defaultEffect(), ...(clip.effect || {}), transition: { ...defaultEffect().transition, ...(clip.effect?.transition || {}) } },
  }));
  p.audioTracks = p.audioTracks || [];
  // Calques d'incrustation : défauts sur chaque champ (projets d'avant cette version).
  p.overlayLayers = (p.overlayLayers || []).map((layer, index) => ({
    id: layer.id || newId("lyr"),
    name: layer.name || `Vidéo ${index + 2}`,
    hidden: !!layer.hidden,
    clips: (layer.clips || []).map((clip) => ({
      ...clip,
      start: Math.max(0, Number(clip.start) || 0),
      duration: Math.max(0.05, Number(clip.duration) || 1),
      offset: Math.max(0, Number(clip.offset) || 0),
      box: { ...defaultBox(), ...(clip.box || {}) },
      fit: clip.fit === "contain" ? "contain" : "cover",
      opacity: typeof clip.opacity === "number" ? clip.opacity : 1,
      rotation: Number(clip.rotation) || 0,
      motion: { ...defaultMotion(), ...(clip.motion || {}) },
      fadeIn: Number(clip.fadeIn) || 0,
      fadeOut: Number(clip.fadeOut) || 0,
      keys: Array.isArray(clip.keys) && clip.keys.length
        ? clip.keys
            .map((key) => ({
              t: clamp(Number(key?.t) || 0, 0, 3600),
              box: { ...defaultBox(), ...(key?.box || {}) },
              rotation: Number(key?.rotation) || 0,
              opacity: clamp(Number(key?.opacity ?? 1), 0, 1),
            }))
            .sort((a, b) => a.t - b.t)
        : undefined,
      ease: clip.ease === "smooth" ? "smooth" : "linear",
      audio: { mute: clip.audio?.mute !== false, gain: Number(clip.audio?.gain) || 1 },
      createdAt: clip.createdAt || Date.now(),
    })),
  }));
  p.texts = (p.texts || []).map((text) => ({
    ...text,
    start: Math.max(0, Number(text.start) || 0),
    duration: Math.max(0.05, Number(text.duration) || 2),
    box: { ...defaultTextBox(), ...(text.box || {}) },
    rotation: Number(text.rotation) || 0,
    z: Number(text.z) || 0,
    style: { ...defaultTextStyle(), ...(text.style || {}) },
    animation: { ...defaultTextAnimation(), ...(text.animation || {}) },
    createdAt: text.createdAt || Date.now(),
  }));
  p.subtitles = { ...defaultSubtitles(), ...(p.subtitles || {}) };
  p.output = { width: 1920, height: 1080, fps: 30, normalize: true, crf: 20, ...(p.output || {}) };
  return p;
}

export async function saveProject(project: Project) {
  project.updatedAt = Date.now();
  await ensureProjectDirs(project.id);
  await writeJson(projectPath(project.id), project);
}

export function sourcePath(pid: string, source: Source) {
  return `${mediaDir(pid)}/${source.file}`;
}

export function sourceById(project: Project, id: string) {
  return project.sources.find((s) => s.id === id) ?? null;
}

export async function deleteSourceFile(pid: string, source: Source) {
  try {
    await fs.rm(sourcePath(pid, source));
  } catch {}
}

export function mediaUrl(pid: string, source: Source) {
  return `/media/${pid}/${encodeURIComponent(source.file)}`;
}

export function buildUrl(pid: string, file: string) {
  return `/media/${pid}/${encodeURIComponent(file)}`;
}

/** Durée totale du montage = durée de la voix compilée (ou 0). */
export function montageDuration(project: Project) {
  if (project.voice.build) return project.voice.build.duration;
  return 0;
}
