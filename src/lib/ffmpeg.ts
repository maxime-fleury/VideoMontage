import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { FFMPEG, FFPROBE, buildDir, clamp, commandExists, ensureDir, run, runSync } from "./util";
import type {
  AudioTrack,
  Denoise,
  OverlayClip,
  Project,
  Range,
  Segment,
  Source,
  VideoClip,
  VoiceBuild,
  VoiceEdits,
} from "./store";
import { sourceById, sourcePath } from "./store";
import { writeSubtitles } from "./subtitles";
import { writeTexts } from "./texts";
import { motionExprs } from "./motions";
import { FONTS_DIR } from "./fonts";

export function ffmpegAvailable() {
  return commandExists(FFMPEG);
}

export type ProbeResult = {
  duration: number;
  sampleRate?: number;
  channels?: number;
  width?: number;
  height?: number;
  fps?: number;
  codec?: string;
  hasAudio: boolean;
  hasVideo: boolean;
};

export async function probe(file: string): Promise<ProbeResult> {
  const res = await run([
    FFPROBE,
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    file,
  ]);
  if (res.code !== 0) throw new Error(`ffprobe a échoué : ${res.stderr.slice(0, 300)}`);
  const data = JSON.parse(res.stdout);
  const streams: any[] = data.streams || [];
  const audio = streams.find((s) => s.codec_type === "audio");
  const video = streams.find((s) => s.codec_type === "video");
  let fps: number | undefined;
  if (video?.avg_frame_rate && video.avg_frame_rate !== "0/0") {
    const [num, den] = video.avg_frame_rate.split("/").map(Number);
    if (den) fps = num / den;
  }
  return {
    duration: Number(data.format?.duration ?? audio?.duration ?? video?.duration ?? 0),
    sampleRate: audio ? Number(audio.sample_rate) : undefined,
    channels: audio ? Number(audio.channels) : undefined,
    width: video ? Number(video.width) : undefined,
    height: video ? Number(video.height) : undefined,
    fps,
    codec: audio?.codec_name || video?.codec_name,
    hasAudio: !!audio,
    hasVideo: !!video,
  };
}

/** Détecte les silences et renvoie les intervalles (temps source). */
export async function detectSilences(
  file: string,
  thresholdDb = -35,
  minDuration = 0.35,
  pad = 0.06
): Promise<Range[]> {
  const res = await run([
    FFMPEG,
    "-hide_banner",
    "-nostdin",
    "-i",
    file,
    "-af",
    `silencedetect=noise=${thresholdDb}dB:d=${minDuration}`,
    "-f",
    "null",
    "-",
  ]);
  const silences: Range[] = [];
  let current: number | null = null;
  const re = /silence_(start|end):\s*(-?[\d.]+)(?:\s*\|\s*silence_duration:\s*([\d.]+))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(res.stderr))) {
    if (m[1] === "start") current = Number(m[2]);
    else if (current !== null) {
      const end = Number(m[2]);
      silences.push({ start: current, end });
      current = null;
    }
  }
  if (current !== null) silences.push({ start: current, end: 1e9 });
  return silences.map((s) => ({ start: s.start + pad, end: Math.max(s.start + pad, s.end - pad) }));
}

export type NoiseAnalysis = {
  /** niveau des passages les plus calmes (15e centile) */
  noiseFloorDb: number;
  /** niveau parlé haut (95e centile) */
  speechDb: number;
  /** seuil de silence proposé, déduit du plancher de bruit */
  suggestedThresholdDb: number;
  windows: number;
};

const noiseCache = new Map<string, { key: string; value: NoiseAnalysis }>();

/**
 * Mesure le plancher de bruit réel de la voix (RMS par fenêtre) pour choisir un seuil
 * de silence adapté, plutôt qu'un −35 dB fixe qui rate les prises bruyantes ou coupe
 * les respirations d'une prise très propre.
 */
export async function analyzeNoiseFloor(
  file: string,
  windowSeconds = 0.4,
  thresholdOffset = 6
): Promise<NoiseAnalysis> {
  const stat = await fs.stat(file).catch(() => null);
  const cacheKey = `${file}:${stat?.size ?? 0}:${stat ? Math.round(stat.mtimeMs) : 0}`;
  const cached = noiseCache.get(file);
  if (cached && cached.key === cacheKey) return cached.value;

  const sampleRate = 16000;
  const windowSamples = Math.max(400, Math.round(sampleRate * windowSeconds));
  const res = await run([
    FFMPEG,
    "-hide_banner",
    "-nostdin",
    "-i",
    file,
    "-af",
    `aresample=${sampleRate},asetnsamples=n=${windowSamples},astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level`,
    "-f",
    "null",
    "-",
  ]);

  const levels: number[] = [];
  for (const m of res.stderr.matchAll(/RMS_level=([-\d.]+|[-\w]*inf)/gi)) {
    const raw = m[1];
    if (/inf/i.test(raw)) {
      levels.push(-90);
      continue;
    }
    const value = Number(raw);
    if (Number.isFinite(value)) levels.push(value);
  }

  const round1 = (v: number) => Math.round(v * 10) / 10;
  if (levels.length < 3) {
    const fallback: NoiseAnalysis = { noiseFloorDb: -50, speechDb: -6, suggestedThresholdDb: -35, windows: levels.length };
    return fallback;
  }
  const sorted = [...levels].sort((a, b) => a - b);
  const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)))];
  const noiseFloorDb = pick(0.15);
  const value: NoiseAnalysis = {
    noiseFloorDb: round1(noiseFloorDb),
    speechDb: round1(pick(0.95)),
    suggestedThresholdDb: round1(clamp(noiseFloorDb + thresholdOffset, -55, -22)),
    windows: levels.length,
  };
  noiseCache.set(file, { key: cacheKey, value });
  return value;
}

/** Mesure RMS/peak d'une zone (pour le profil de bruit). */
export async function measureRegion(file: string, range: Range): Promise<{ rmsDb: number; peakDb: number }> {
  const res = await run([
    FFMPEG,
    "-hide_banner",
    "-nostdin",
    "-i",
    file,
    "-af",
    `atrim=start=${range.start.toFixed(3)}:end=${range.end.toFixed(3)},volumedetect`,
    "-f",
    "null",
    "-",
  ]);
  const mean = [...res.stderr.matchAll(/mean_volume:\s*(-?[\d.]+) dB/g)].pop();
  const peak = [...res.stderr.matchAll(/max_volume:\s*(-?[\d.]+) dB/g)].pop();
  return {
    rmsDb: mean ? Number(mean[1]) : -60,
    peakDb: peak ? Number(peak[1]) : -60,
  };
}

/** Construit la liste de segments (EDL) à partir des cuts / accélérations. */
export function buildSegments(edits: VoiceEdits, duration: number): Segment[] {
  const normalizeRanges = (ranges: Range[]) =>
    mergeRanges(
      ranges
        .map((r) => ({ start: Math.max(0, r.start), end: Math.min(duration, r.end) }))
        .filter((r) => r.end - r.start > 0.001)
    );

  const cuts = normalizeRanges(edits.cuts);
  let ffwd = normalizeRanges(edits.ffwd);
  // un cut gagne sur un ffwd
  ffwd = subtractRanges(ffwd, cuts);

  const tempo = Math.max(1.5, Math.min(100, edits.ffwdFactor || 100));
  // Les bornes d'édition sont arrondies à la milliseconde : les intervalles et les
  // tests d'appartenance doivent utiliser EXACTEMENT les mêmes valeurs, sinon un
  // silence n'est pas reconnu comme « dans » son propre intervalle (et n'est pas accéléré).
  const round4 = (v: number) => Number(v.toFixed(4));
  const cutsR = cuts.map((c) => ({ start: round4(c.start), end: round4(c.end) }));
  const ffwdR = ffwd.map((f) => ({ start: round4(f.start), end: round4(f.end) }));
  const EPS = 1e-4;
  const edges = new Set<number>([0, duration]);
  for (const r of [...cutsR, ...ffwdR]) {
    edges.add(r.start);
    edges.add(r.end);
  }
  const sorted = [...edges].sort((a, b) => a - b);
  const segments: Segment[] = [];
  let out = 0;
  for (let i = 0; i < sorted.length - 1; i++) {
    const start = sorted[i];
    const end = sorted[i + 1];
    if (end - start < 0.001) continue;
    const isCut = cutsR.some((c) => c.start <= start + EPS && c.end >= end - EPS);
    if (isCut) continue;
    const isFast = ffwdR.some((f) => f.start <= start + EPS && f.end >= end - EPS);
    const t = isFast ? tempo : 1;
    const outDur = (end - start) / t;
    segments.push({ srcStart: start, srcEnd: end, tempo: t, outStart: out, outEnd: out + outDur });
    out += outDur;
  }
  return segments;
}

export function mergeRanges(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + 1e-6) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

export function subtractRanges(base: Range[], holes: Range[]): Range[] {
  let result = mergeRanges(base);
  for (const hole of mergeRanges(holes)) {
    const next: Range[] = [];
    for (const r of result) {
      if (hole.end <= r.start || hole.start >= r.end) {
        next.push(r);
        continue;
      }
      if (hole.start > r.start) next.push({ start: r.start, end: hole.start });
      if (hole.end < r.end) next.push({ start: hole.end, end: r.end });
    }
    result = next;
  }
  return result;
}

/** Convertit une plage du temps compilé vers des plages en temps source. */
export function mapOutToSource(segments: Segment[], start: number, end: number): Range[] {
  const ranges: Range[] = [];
  for (const seg of segments) {
    const s = Math.max(start, seg.outStart);
    const e = Math.min(end, seg.outEnd);
    if (e - s <= 1e-6) continue;
    ranges.push({
      start: seg.srcStart + (s - seg.outStart) * seg.tempo,
      end: seg.srcStart + (e - seg.outStart) * seg.tempo,
    });
  }
  return mergeRanges(ranges);
}

/** Convertit temps source -> temps compilé (pour afficher les silences). */
export function mapSourceToOut(segments: Segment[], t: number): number | null {
  for (const seg of segments) {
    if (t >= seg.srcStart && t <= seg.srcEnd) {
      return seg.outStart + (t - seg.srcStart) / seg.tempo;
    }
  }
  return null;
}

function escapeFilterPath(p: string) {
  return p.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

export function denoiseChain(denoise: Denoise, modelPath?: string): string {
  if (denoise.mode === "none" || !denoise.mode) return "";
  const nr = Math.max(0.1, Math.min(97, denoise.reduction ?? 12));
  if (denoise.mode === "auto") return `afftdn=nr=${nr}:tn=1`;
  if (denoise.mode === "profile") {
    const nf = Math.max(-100, Math.min(-20, denoise.floorDb ?? -50));
    return `afftdn=nr=${nr}:nf=${nf.toFixed(1)}:tn=0`;
  }
  if (denoise.mode === "rnnoise" && modelPath) return `arnndn=m='${escapeFilterPath(modelPath)}'`;
  return "";
}

/** Construit le filtre de compilation de la piste voix. */
function buildVoiceFilter(edits: VoiceEdits, segments: Segment[], modelPath?: string) {
  const pre = denoiseChain(edits.denoise, modelPath);
  const post = edits.normalize ? "loudnorm=I=-16:TP=-1.5:LRA=11" : "";
  const parts: string[] = [];

  const chain = (label: string, seg: Segment, out: string) => {
    const bits = [
      `atrim=start=${seg.srcStart.toFixed(4)}:end=${seg.srcEnd.toFixed(4)}`,
      "asetpts=PTS-STARTPTS",
      "aformat=sample_fmts=flt:channel_layouts=mono",
    ];
    if (seg.tempo > 1.001) bits.push(`atempo=${seg.tempo.toFixed(3)}`);
    parts.push(`[${label}]${bits.join(",")}[${out}]`);
  };

  if (segments.length === 1 && segments[0].tempo === 1) {
    parts.push(`[0:a]${[pre, "anull"].filter(Boolean).join(",")}[pre]`);
    chain("pre", segments[0], "joined");
    parts.push(`[joined]${[post, "anull"].filter(Boolean).join(",")},asplit=2[out1][out2]`);
    return { complex: parts.join(";") };
  }

  parts.push(`[0:a]${[pre, "anull"].filter(Boolean).join(",")},asplit=${segments.length}${segments
    .map((_, i) => `[s${i}]`)
    .join("")}`);
  segments.forEach((seg, i) => chain(`s${i}`, seg, `c${i}`));
  parts.push(`${segments.map((_, i) => `[c${i}]`).join("")}concat=n=${segments.length}:v=0:a=1[joined]`);
  parts.push(`[joined]${[post, "anull"].filter(Boolean).join(",")},asplit=2[out1][out2]`);
  return { complex: parts.join(";") };
}

export type PcmData = { samples: Float32Array; sampleRate: number; channels: number };

export async function readWavSamples(file: string): Promise<PcmData> {
  const buf = new Uint8Array(await Bun.file(file).arrayBuffer());
  const view = new DataView(buf.buffer);
  if (view.getUint32(0, false) !== 0x52494646) throw new Error("WAV invalide");
  let offset = 12;
  let sampleRate = 16000;
  let channels = 1;
  let bits = 16;
  let dataOffset = -1;
  let dataLength = 0;
  while (offset + 8 <= buf.length) {
    const id = String.fromCharCode(buf[offset], buf[offset + 1], buf[offset + 2], buf[offset + 3]);
    const size = view.getUint32(offset + 4, true);
    if (id === "fmt ") {
      channels = view.getUint16(offset + 10, true);
      sampleRate = view.getUint32(offset + 12, true);
      bits = view.getUint16(offset + 22, true);
    } else if (id === "data") {
      dataOffset = offset + 8;
      dataLength = size;
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (dataOffset < 0) throw new Error("WAV sans données");
  const count = Math.floor(dataLength / (bits / 8));
  const samples = new Float32Array(count);
  if (bits === 16) {
    for (let i = 0; i < count; i++) samples[i] = view.getInt16(dataOffset + i * 2, true) / 32768;
  } else if (bits === 32) {
    for (let i = 0; i < count; i++) samples[i] = view.getFloat32(dataOffset + i * 4, true);
  } else if (bits === 8) {
    for (let i = 0; i < count; i++) samples[i] = (view.getUint8(dataOffset + i) - 128) / 128;
  }
  return { samples, sampleRate, channels };
}

export function computePeaks(samples: Float32Array, buckets = 2000) {
  const peaks: number[] = [];
  const size = Math.max(1, Math.floor(samples.length / buckets));
  for (let b = 0; b < buckets; b++) {
    const start = b * size;
    const end = Math.min(samples.length, start + size);
    let min = 0;
    let max = 0;
    for (let i = start; i < end; i++) {
      const v = samples[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    peaks.push(min, max);
  }
  return peaks;
}

export function pcmStats(samples: Float32Array) {
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i];
    sum += v * v;
    const a = Math.abs(v);
    if (a > peak) peak = a;
  }
  const rms = Math.sqrt(sum / Math.max(1, samples.length));
  const toDb = (v: number) => (v <= 1e-7 ? -100 : 20 * Math.log10(v));
  return { meanDb: Number(toDb(rms).toFixed(1)), peakDb: Number(toDb(peak).toFixed(1)) };
}

async function findRnnoiseModel(explicit?: string) {
  if (explicit) return explicit;
  try {
    const files = await fs.readdir("data/models");
    const model = files.find((f) => f.endsWith(".rnnn"));
    if (model) return `data/models/${model}`;
  } catch {}
  return undefined;
}

export type CompileResult = VoiceBuild;

/** Compile la piste voix: débruitage -> cuts -> accélérations -> concat -> artefacts de prévisualisation. */
export async function compileVoice(
  project: Project,
  onProgress?: (p: number, message?: string) => void
): Promise<CompileResult> {
  const source = project.voice.sourceId ? sourceById(project, project.voice.sourceId) : null;
  if (!source) throw new Error("Aucune piste voix sélectionnée");
  if (!source.duration) throw new Error("Durée de la source inconnue");
  const src = sourcePath(project.id, source);
  const bdir = buildDir(project.id);
  await ensureDir(bdir);

  const edits = project.voice.edits;
  const segments = buildSegments(edits, source.duration);
  if (segments.length === 0) throw new Error("Tout l'audio a été supprimé — annule des coupes");
  const modelPath = edits.denoise.mode === "rnnoise" ? await findRnnoiseModel(edits.denoise.model) : undefined;
  if (edits.denoise.mode === "rnnoise" && !modelPath) throw new Error("Modèle RNNoise introuvable (voir Paramètres)");

  const { complex } = buildVoiceFilter(edits, segments, modelPath);
  const mp3 = `${bdir}/voice.mp3`;
  const wav16 = `${bdir}/voice16k.wav`;
  const tmpWav = `${bdir}/voice.tmp.wav`;
  onProgress?.(0.1, "Application des traitements…");

  const res = await run([
    FFMPEG,
    "-hide_banner",
    "-nostdin",
    "-y",
    "-i",
    src,
    "-filter_complex",
    complex,
    "-map",
    "[out1]",
    "-ar",
    "44100",
    "-ac",
    "1",
    "-c:a",
    "libmp3lame",
    "-b:a",
    "160k",
    mp3,
    "-map",
    "[out2]",
    "-ar",
    "16000",
    "-ac",
    "1",
    "-c:a",
    "pcm_s16le",
    wav16,
  ]);
  if (res.code !== 0) {
    throw new Error(`ffmpeg (compilation voix) a échoué : ${res.stderr.slice(-600)}`);
  }
  onProgress?.(0.6, "Analyse de la forme d'onde…");

  const pcm = await readWavSamples(wav16);
  const duration = pcm.samples.length / pcm.sampleRate;
  const bucketCount = Math.max(400, Math.min(6000, Math.round(duration * 60)));
  const peaks = computePeaks(pcm.samples, bucketCount);
  const stats = pcmStats(pcm.samples);
  await fs.rm(tmpWav, { force: true });

  const build: VoiceBuild = {
    sourceId: source.id,
    duration: Number(duration.toFixed(4)),
    segments,
    peaks,
    peaksBuckets: bucketCount,
    audioFile: "voice.mp3",
    wavFile: "voice16k.wav",
    stats,
    builtAt: Date.now(),
    hash: `${source.id}:${edits.cuts.length}c${edits.ffwd.length}f${edits.denoise.mode}${edits.denoise.reduction}${edits.denoise.floorDb ?? ""}${edits.normalize ? "n" : ""}:${duration.toFixed(2)}`,
  };
  onProgress?.(1, "Piste voix prête");
  return build;
}

// ---------------------------------------------------------------------------
// Rendu final
// ---------------------------------------------------------------------------

/** Partie « spatiale » du traitement d'un clip : taille, cadrage, mouvements de zoom.
 *  C'est la partie coûteuse (zoompan en 1080p) et elle ne dépend ni du temps de la
 *  timeline ni des fondus → elle est mise en cache par clip. */
function clipSpatialFilters(
  clip: VideoClip,
  renderedDuration: number,
  out: { width: number; height: number; fps: number }
) {
  const { width: W, height: H, fps } = out;
  const dur = Math.max(0.05, renderedDuration);
  const transition = clip.effect?.transition?.type || "cut";
  const transDur = Math.max(0, clip.effect?.transition?.duration ?? 0);
  const reveal =
    transDur > 0.05 && ["dissolve", "slide-left", "slide-right", "slide-up", "slide-down", "zoom-in"].includes(transition);
  const filters = [
    `scale=${W}:${H}:force_original_aspect_ratio=decrease`,
    `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black`,
    "setsar=1",
    `fps=${fps}`,
  ];
  if (clip.effect.kenBurns) {
    const z0 = clip.effect.zoomFrom || 1;
    const z1 = clip.effect.zoomTo || 1.12;
    const frames = Math.max(2, Math.round(dur * fps));
    filters.push(
      `zoompan=z='${z0}+(${z1}-${z0})*on/${frames}':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${W}x${H}:fps=${fps}`
    );
  }
  if (transition === "zoom-in" && reveal) {
    const frames = Math.max(2, Math.round(transDur * fps));
    filters.push(
      `zoompan=z='if(lt(on,${frames}),${(1.12).toFixed(3)}-${(0.12).toFixed(3)}*on/${frames},1)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${W}x${H}:fps=${fps}`
    );
  }
  return filters;
}

/** Partie « temporelle » : fondus, transparence de transition et position sur la timeline.
 *  Peu coûteuse, elle est appliquée à l'assemblage (elle dépend des voisins et des coupes). */
function clipTimelineFilters(clip: VideoClip, renderedDuration: number): string[] {
  const dur = Math.max(0.05, renderedDuration);
  const transition = clip.effect?.transition?.type || "cut";
  const transDur = Math.max(0, clip.effect?.transition?.duration ?? 0);
  const reveal =
    transDur > 0.05 && ["dissolve", "slide-left", "slide-right", "slide-up", "slide-down", "zoom-in"].includes(transition);
  // les fondus d'entrée/sortie "noir" restent utilisables seuls
  const fadeIn = Math.max(0, Math.min(clip.effect.fadeIn, dur / 2));
  const fadeOut = Math.max(0, Math.min(clip.effect.fadeOut, dur / 2));
  const filters: string[] = [];
  if (reveal) {
    // fusion progressive sur le clip précédent (nécessite l'alpha)
    filters.push("format=rgba");
    filters.push(`fade=t=in:st=0:d=${transDur.toFixed(3)}:alpha=1`);
  } else if (fadeIn > 0.01) {
    filters.push(`fade=t=in:st=0:d=${fadeIn.toFixed(3)}`);
  }
  if (fadeOut > 0.01) filters.push(`fade=t=out:st=${(dur - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}`);
  filters.push(`setpts=PTS-STARTPTS+${clip.start.toFixed(3)}/TB`);
  return filters;
}

function clipFilter(
  clip: VideoClip,
  index: number,
  inputIndex: number,
  renderedDuration: number,
  out: { width: number; height: number; fps: number }
) {
  const parts = [
    ...clipSpatialFilters(clip, renderedDuration, out),
    ...clipTimelineFilters(clip, renderedDuration),
  ];
  return `[${inputIndex}:v]${parts.join(",")}[clip${index}]`;
}

/** Version du cache : à incrémenter si le rendu d'un clip change. */
const CLIP_CACHE_VERSION = 1;
const CLIP_CACHE_MAX_AGE_MS = 21 * 24 * 3600 * 1000;

/** Clé de cache d'un clip : tout ce qui influence son image, sans ce qui dépend des voisins. */
async function clipCacheKey(
  project: Project,
  clip: VideoClip,
  renderedDuration: number,
  source: Source,
  out: { width: number; height: number; fps: number }
) {
  const stat = await fs.stat(sourcePath(project.id, source)).catch(() => null);
  const transition = clip.effect?.transition;
  const payload = {
    v: CLIP_CACHE_VERSION,
    file: source.file,
    size: stat?.size ?? 0,
    mtime: stat ? Math.round(stat.mtimeMs) : 0,
    kind: source.kind,
    offset: Number((clip.offset || 0).toFixed(3)),
    duration: Number(renderedDuration.toFixed(3)),
    kenBurns: clip.effect?.kenBurns ? [clip.effect.zoomFrom ?? 1, clip.effect.zoomTo ?? 1.12] : null,
    zoomIn: transition?.type === "zoom-in" ? Number((transition.duration || 0).toFixed(3)) : null,
    size_px: [out.width, out.height, out.fps],
  };
  return crypto.createHash("sha1").update(JSON.stringify(payload)).digest("hex").slice(0, 20);
}

/** Rend un clip en petit MP4 réutilisable (partie spatiale uniquement, sans audio). */
async function renderClipCache(
  project: Project,
  clip: VideoClip,
  renderedDuration: number,
  source: Source,
  out: { width: number; height: number; fps: number },
  target: string
): Promise<boolean> {
  const file = path.resolve(sourcePath(project.id, source));
  const argv = ["-hide_banner", "-nostdin", "-y", "-v", "error"];
  if (source.kind === "video") {
    argv.push("-ss", Math.max(0, clip.offset).toFixed(3), "-t", renderedDuration.toFixed(3), "-i", file);
  } else {
    argv.push("-loop", "1", "-framerate", String(out.fps), "-t", renderedDuration.toFixed(3), "-i", file);
  }
  argv.push(
    "-filter_complex",
    `[0:v]${clipSpatialFilters(clip, renderedDuration, out).join(",")}[v]`,
    "-map",
    "[v]",
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "14",
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(out.fps),
    "-movflags",
    "+faststart",
    target
  );
  const res = await run([FFMPEG, ...argv]);
  if (res.code !== 0) {
    console.warn(`⚠️  cache de clip impossible (${source.file}) : ${res.stderr.slice(-300)}`);
    await fs.rm(target, { force: true }).catch(() => {});
    return false;
  }
  return true;
}

/** Supprime les caches de clips trop anciens (les exports suivants les recréent). */
async function cleanupClipCache(dir: string) {
  const files = await fs.readdir(dir).catch(() => []);
  const now = Date.now();
  for (const name of files) {
    if (!name.endsWith(".mp4")) continue;
    const stat = await fs.stat(`${dir}/${name}`).catch(() => null);
    if (stat && now - stat.mtimeMs > CLIP_CACHE_MAX_AGE_MS) await fs.rm(`${dir}/${name}`, { force: true }).catch(() => {});
  }
}

/**
 * Chaîne de filtres d'une incrustation (calque vidéo/image) : cadrage dans le
 * rectangle voulu, opacité, fondus, rotation puis mouvement prédéfini.
 * Les positions/taille sont des fractions du cadre de sortie, comme dans l'aperçu.
 */
function overlayChain(clip: OverlayClip, duration: number, out: { width: number; height: number }): {
  chain: string;
  position: string;
} {
  const width = Math.max(2, Math.round((clip.box.w * out.width) / 2) * 2);
  const height = Math.max(2, Math.round((clip.box.h * out.height) / 2) * 2);
  const parts: string[] = ["setpts=PTS-STARTPTS"];
  parts.push(
    clip.fit === "contain"
      ? `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black@0`
      : `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`
  );
  parts.push("format=rgba");
  const opacity = Math.max(0, Math.min(1, clip.opacity ?? 1));
  if (opacity < 0.999) parts.push(`colorchannelmixer=aa=${opacity.toFixed(3)}`);
  const fadeIn = Math.max(0, Math.min(clip.fadeIn || 0, duration / 2));
  const fadeOut = Math.max(0, Math.min(clip.fadeOut || 0, duration / 2));
  if (fadeIn > 0.02) parts.push(`fade=t=in:st=0:d=${fadeIn.toFixed(3)}:alpha=1`);
  if (fadeOut > 0.02) parts.push(`fade=t=out:st=${(duration - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}:alpha=1`);
  if (clip.rotation) parts.push(`rotate=${((clip.rotation * Math.PI) / 180).toFixed(6)}:c=none:ow=rotw(iw):oh=roth(ih)`);

  const exprs = motionExprs(clip.motion, clip.box, duration);
  if (exprs.scale !== "1") {
    // Échelle animée autour du centre : `t` est le temps local du clip (voir setpts).
    parts.push(`scale=w='2*ceil(${width}*(${exprs.scale})/2)':h='2*ceil(${height}*(${exprs.scale})/2)':eval=frame`);
  }
  // `w`/`h` = taille courante de l'incrustation (après rotation/échelle) → centré.
  // Les expressions doivent rester entre quotes simples : les gabarits de mouvement
  // contiennent des virgules (min/max) que ffmpeg prendrait pour des séparateurs.
  const centerX = (clip.box.x + clip.box.w / 2).toFixed(4);
  const centerY = (clip.box.y + clip.box.h / 2).toFixed(4);
  const x = `(${centerX}*W-w/2+(${exprs.dx})*W)`;
  const y = `(${centerY}*H-h/2+(${exprs.dy})*H)`;
  return { chain: parts.join(","), position: `x='${x}':y='${y}'` };
}

/** Expression de position de l'overlay pour les transitions glissées. */
function overlayPosition(clip: VideoClip) {
  const transition = clip.effect?.transition || { type: "cut", duration: 0 };
  const d = Math.max(0.05, transition.duration || 0);
  const st = clip.start.toFixed(3);
  const progress = `min(1,max(0,(t-${st})/${d.toFixed(3)}))`;
  switch (transition.type) {
    case "slide-right":
      return `x='W*(1-${progress})':y=0`;
    case "slide-left":
      return `x='-W*(1-${progress})':y=0`;
    case "slide-down":
      return `x=0:y='H*(1-${progress})'`;
    case "slide-up":
      return `x=0:y='-H*(1-${progress})'`;
    default:
      return "0:0";
  }
}

export type RenderOptions = {
  fileName?: string;
  width?: number;
  height?: number;
  fps?: number;
  crf?: number;
  normalize?: boolean;
};

export function sanitizeFileName(name: string) {
  return name.replace(/[^\w.\- ]+/g, "_").replace(/\s+/g, " ");
}

/** Rend le montage complet en MP4 (vidéo + audio mixé). */
export async function renderMontage(
  project: Project,
  opts: RenderOptions,
  onProgress?: (p: number, message?: string) => void
): Promise<{ file: string; url: string; duration: number }> {
  const build = project.voice.build;
  if (!build) throw new Error("Compile d'abord la piste voix");
  const W = opts.width || project.output.width;
  const H = opts.height || project.output.height;
  const fps = opts.fps || project.output.fps;
  const crf = opts.crf ?? project.output.crf;
  const duration = build.duration;

  // le rendu tourne dans le dossier build/ (pour le fichier .ass), donc les
  // chemins de médias doivent être absolus
  const abs = (p: string) => path.resolve(p);
  const argv: string[] = ["-hide_banner", "-nostdin", "-y", "-progress", "pipe:1", "-nostats"];
  const clips = [...project.videoTrack].sort((a, b) => a.start - b.start).filter((c) => c.duration > 0.02);
  const tracks = project.audioTracks.filter((t) => !t.muted);

  // Entrée 0 : fond noir
  argv.push("-f", "lavfi", "-i", `color=c=black:s=${W}x${H}:r=${fps}:d=${duration.toFixed(3)}`);

  // Durées réellement rendues: un clip qui "révèle" le suivant doit rester visible
  // pendant la transition, on l'étend donc si nécessaire.
  const rendered = clips.map((c) => ({ clip: c, duration: c.duration }));
  for (let i = 1; i < rendered.length; i++) {
    const transition = rendered[i].clip.effect?.transition;
    if (!transition || transition.duration < 0.05) continue;
    if (!["dissolve", "slide-left", "slide-right", "slide-up", "slide-down", "zoom-in"].includes(transition.type)) continue;
    const previous = rendered[i - 1];
    const previousEnd = previous.clip.start + previous.duration;
    if (previousEnd < rendered[i].clip.start - 0.05) continue;
    const src = sourceById(project, previous.clip.sourceId);
    const maxDuration =
      src?.kind === "video" ? Math.max(previous.duration, (src.duration || previous.duration) - previous.clip.offset) : 3600;
    const needed = rendered[i].clip.start + transition.duration - previous.clip.start;
    previous.duration = Math.min(Math.max(previous.duration, needed), maxDuration);
  }

  const inputs: {
    kind: "clip" | "voice" | "audio";
    index: number;
    clip?: VideoClip;
    track?: AudioTrack;
    audioClip?: any;
    cached?: boolean;
  }[] = [];
  let inputIndex = 1;

  // Cache par clip : la partie spatiale (recadrage, zoom) est réutilisée d'un export
  // à l'autre tant que le clip ne change pas → les ré-exports sont bien plus rapides.
  const cacheDir = `${buildDir(project.id)}/cache`;
  await ensureDir(cacheDir);
  await cleanupClipCache(cacheDir);
  const cachePaths = new Map<string, string>();
  let prepared = 0;
  for (const entry of rendered) {
    const source = sourceById(project, entry.clip.sourceId);
    if (!source) continue;
    const key = await clipCacheKey(project, entry.clip, entry.duration, source, { width: W, height: H, fps });
    const target = `${cacheDir}/${key}.mp4`;
    if (await Bun.file(target).exists()) {
      cachePaths.set(entry.clip.id, target);
      continue;
    }
    onProgress?.(0.02, `Préparation des clips ${prepared + 1}/${rendered.length}…`);
    if (await renderClipCache(project, entry.clip, entry.duration, source, { width: W, height: H, fps }, target)) {
      cachePaths.set(entry.clip.id, target);
    }
    prepared++;
  }

  for (const entry of rendered) {
    const clip = entry.clip;
    const source = sourceById(project, clip.sourceId);
    if (!source) continue;
    const cached = cachePaths.get(clip.id);
    if (cached) {
      argv.push("-i", abs(cached));
      inputs.push({ kind: "clip", index: inputIndex++, clip, cached: true });
      continue;
    }
    const file = abs(sourcePath(project.id, source));
    if (source.kind === "video") {
      argv.push("-ss", Math.max(0, clip.offset).toFixed(3), "-t", entry.duration.toFixed(3), "-i", file);
    } else {
      argv.push("-loop", "1", "-framerate", String(fps), "-t", entry.duration.toFixed(3), "-i", file);
    }
    inputs.push({ kind: "clip", index: inputIndex++, clip });
  }

  // Voix
  argv.push("-i", abs(`${buildDir(project.id)}/${build.audioFile}`));
  const voiceIndex = inputIndex++;
  inputs.push({ kind: "voice", index: voiceIndex });

  // Pistes audio supplémentaires
  for (const track of tracks) {
    for (const ac of track.clips) {
      const source = sourceById(project, ac.sourceId);
      if (!source || source.kind === "image") continue;
      const file = abs(sourcePath(project.id, source));
      const dur = Math.max(0.05, ac.duration);
      if (ac.loop) argv.push("-stream_loop", "-1");
      argv.push("-ss", Math.max(0, ac.offset).toFixed(3), "-t", dur.toFixed(3), "-i", file);
      inputs.push({ kind: "audio", index: inputIndex++, track, audioClip: ac });
    }
  }

  // Calques d'incrustation (Vidéo 2, 3…) : vidéo/image par-dessus la piste principale.
  const layers = (project.overlayLayers || []).filter((layer) => !layer.hidden);
  const overlayInputs: { index: number; clip: OverlayClip }[] = [];
  for (const layer of layers) {
    for (const clip of [...layer.clips].sort((a, b) => a.start - b.start)) {
      if (!(clip.duration > 0.02)) continue;
      const source = sourceById(project, clip.sourceId);
      if (!source) continue;
      const file = abs(sourcePath(project.id, source));
      if (source.kind === "video") {
        argv.push("-ss", Math.max(0, clip.offset).toFixed(3), "-t", clip.duration.toFixed(3), "-i", file);
      } else {
        argv.push("-loop", "1", "-framerate", String(fps), "-t", clip.duration.toFixed(3), "-i", file);
      }
      overlayInputs.push({ index: inputIndex++, clip });
      // Bande son de la vidéo incrustée (coupée par défaut).
      if (source.kind === "video" && clip.audio && clip.audio.mute === false) {
        argv.push("-ss", Math.max(0, clip.offset).toFixed(3), "-t", clip.duration.toFixed(3), "-i", file);
        inputs.push({
          kind: "audio",
          index: inputIndex++,
          audioClip: {
            id: `${clip.id}-audio`,
            sourceId: clip.sourceId,
            start: clip.start,
            duration: clip.duration,
            offset: clip.offset,
            gain: clip.audio.gain ?? 1,
            fadeIn: clip.fadeIn || 0,
            fadeOut: clip.fadeOut || 0,
          },
        });
      }
    }
  }

  const filters: string[] = [];

  // Vidéo : un filtre par clip puis empilement par overlay
  let lastVideo = "0:v";
  let vIndex = 0;
  inputs.forEach((input, i) => {
    if (input.kind !== "clip" || !input.clip) return;
    const entry = rendered.find((r) => r.clip === input.clip);
    const clipDuration = entry ? entry.duration : input.clip.duration;
    filters.push(
      input.cached
        ? // segment déjà recadré/zoomé : il ne reste que les fondus et le placement
          `[${input.index}:v]${clipTimelineFilters(input.clip, clipDuration).join(",")}[clip${i}]`
        : clipFilter(input.clip, i, input.index, clipDuration, { width: W, height: H, fps })
    );
    const outLabel = `v${vIndex}`;
    filters.push(
      `[${lastVideo}][clip${i}]overlay=${overlayPosition(input.clip)}:eof_action=pass:shortest=0[${outLabel}]`
    );
    lastVideo = outLabel;
    vIndex++;
  });

  // Incrustations : empilées après la piste principale, dans l'ordre des calques.
  for (const overlay of overlayInputs) {
    const { chain, position } = overlayChain(overlay.clip, overlay.clip.duration, { width: W, height: H });
    filters.push(`[${overlay.index}:v]${chain}[ov${vIndex}]`);
    const outLabel = `vo${vIndex}`;
    const end = overlay.clip.start + overlay.clip.duration;
    filters.push(
      `[${lastVideo}][ov${vIndex}]overlay=${position}:enable='between(t,${overlay.clip.start.toFixed(3)},${end.toFixed(3)})':eof_action=pass:shortest=0[${outLabel}]`
    );
    lastVideo = outLabel;
    vIndex++;
  }

  // Sous-titres et textes libres incrustés (libass), ou simple conversion de format.
  const subtitleFile = await writeSubtitles(project, W, H);
  const textFile = await writeTexts(project, W, H);
  const assLayers: string[] = [];
  if (subtitleFile) assLayers.push(`ass=filename=${subtitleFile}:fontsdir=ttf`);
  if (textFile) assLayers.push(`ass=filename=${textFile}:fontsdir=ttf`);
  if (assLayers.length) {
    // Les TTF sont dans ./ttf (sous-dossier) : libass ne scanne plus les .ass eux-mêmes.
    filters.push(`[${lastVideo}]${assLayers.join(",")},format=yuv420p[vout]`);
    onProgress?.(
      0.01,
      assLayers.length > 1
        ? "Sous-titres et textes incrustés (libass + polices locales)"
        : subtitleFile
          ? "Sous-titres incrustés (libass + polices locales)"
          : "Textes incrustés (libass + polices locales)"
    );
  } else {
    filters.push(`[${lastVideo}]format=yuv420p[vout]`);
  }

  // Audio
  const voiceChain = ["aresample=48000", "aformat=sample_fmts=fltp:channel_layouts=stereo"];
  if (opts.normalize ?? project.output.normalize) voiceChain.push("loudnorm=I=-16:TP=-1.5:LRA=11");
  filters.push(`[${voiceIndex}:a]${voiceChain.join(",")}[vox]`);
  const mixInputs = ["[vox]"];
  let audioCount = 0;
  for (const input of inputs) {
    if (input.kind !== "audio" || !input.audioClip) continue;
    const ac = input.audioClip;
    const dur = Math.max(0.05, ac.duration);
    const gain = Math.max(0, ac.gain ?? 1);
    const fadeIn = Math.max(0, Math.min(ac.fadeIn ?? 0, dur / 2));
    const fadeOut = Math.max(0, Math.min(ac.fadeOut ?? 0, dur / 2));
    const chain = [
      "aresample=48000",
      "aformat=sample_fmts=fltp:channel_layouts=stereo",
      `volume=${gain.toFixed(3)}`,
    ];
    if (fadeIn > 0.01) chain.push(`afade=t=in:st=0:d=${fadeIn.toFixed(3)}`);
    if (fadeOut > 0.01) chain.push(`afade=t=out:st=${(dur - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}`);
    const delayMs = Math.max(0, Math.round(ac.start * 1000));
    chain.push(`adelay=${delayMs}|${delayMs}`);
    filters.push(`[${input.index}:a]${chain.join(",")}[aux${audioCount}]`);
    mixInputs.push(`[aux${audioCount}]`);
    audioCount++;
  }
  if (audioCount === 0) {
    filters.push("[vox]anull[aout]");
  } else {
    filters.push(
      `${mixInputs.join("")}amix=inputs=${mixInputs.length}:duration=longest:normalize=0,alimiter=limit=0.97[aout]`
    );
  }

  let outName = opts.fileName ? sanitizeFileName(opts.fileName) : `montage-${project.id}.mp4`;
  // sans extension, ffmpeg ne sait pas quel format produire
  if (!/\.(mp4|mov|mkv|webm)$/i.test(outName)) outName += ".mp4";
  const outPath = abs(`${buildDir(project.id)}/${outName}`);
  argv.push(
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[vout]",
    "-map",
    "[aout]",
    "-r",
    String(fps),
    "-t",
    duration.toFixed(3),
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    String(crf),
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-ar",
    "48000",
    "-movflags",
    "+faststart",
    outPath
  );

  let lastProgress = 0;
  const res = await run([FFMPEG, ...argv], {
    // cwd = dossier des polices: le .ass y est écrit, les TTF sont dans ./ttf (fontsdir).
    cwd: FONTS_DIR,
    onStdout: (chunk) => {
      for (const line of chunk.split("\n")) {
        const m = line.match(/out_time_ms=(\d+)/);
        if (m) {
          const seconds = Number(m[1]) / 1e6;
          const p = Math.max(0, Math.min(0.98, seconds / duration));
          if (p - lastProgress > 0.01) {
            lastProgress = p;
            onProgress?.(p, `Rendu vidéo ${Math.round(p * 100)}%`);
          }
        }
      }
    },
  });
  if (res.code !== 0) {
    // Diagnostic : la première ligne d'erreur est la plus utile, la fin montre le détail.
    const lines = res.stderr.split(/\r?\n/).filter(Boolean);
    const first = lines.find((line) => /error|Invalid|No such|Unable|Cannot|not found/i.test(line)) || lines[0] || "";
    throw new Error(`ffmpeg (rendu) a échoué : ${first}\n${res.stderr.slice(-1600)}`);
  }
  onProgress?.(1, "Rendu terminé");
  return { file: outName, url: `/media/${project.id}/${encodeURIComponent(outName)}`, duration };
}
