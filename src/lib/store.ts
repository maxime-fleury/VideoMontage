import fs from "node:fs/promises";
import { DATA_DIR, MODELS_DIR, PROJECTS_DIR, TOOLS_DIR, mediaDir, newId, projectDir, writeJson, readJson, buildDir } from "./util";
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
  meta?: Record<string, unknown>;
  createdAt: number;
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
  p.voice = p.voice || { edits: defaultEdits() };
  p.voice.edits = { ...defaultEdits(), ...p.voice.edits, denoise: { ...defaultEdits().denoise, ...p.voice.edits?.denoise } };
  p.videoTrack = (p.videoTrack || []).map((clip) => ({
    ...clip,
    effect: { ...defaultEffect(), ...(clip.effect || {}), transition: { ...defaultEffect().transition, ...(clip.effect?.transition || {}) } },
  }));
  p.audioTracks = p.audioTracks || [];
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
