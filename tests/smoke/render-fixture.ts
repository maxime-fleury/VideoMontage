/**
 * Fixture du test de fumée du rendu — **lancée dans un processus séparé** par
 * `tests/render.test.ts`, avec `MONTAGE_DATA_DIR` déjà positionné.
 *
 * Pourquoi un processus : `src/lib/util.ts` lit `MONTAGE_DATA_DIR` au moment de
 * l'import. Dans `bun test`, tous les fichiers de test partagent les modules déjà
 * importés par les autres tests, si bien qu'une variable posée dans le test
 * arriverait trop tard et le projet de test serait créé dans le **vrai** `data/`.
 * Ici le dossier temporaire est fixé avant que quoi que ce soit ne soit importé.
 *
 * Elle monte un vrai projet d'une seconde (mire, incrustation sur fond vert avec
 * opacité animée, incrustation déplacée/redimensionnée, voix), appelle
 * `renderMontage` puis relit le MP4 et imprime les mesures en JSON.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { FFMPEG, FFPROBE, buildDir, ensureDir, mediaDir, run } from "../../src/lib/util";
import { createProject, defaultBox, defaultEffect, defaultMotion, saveProject } from "../../src/lib/store";
import { renderMontage } from "../../src/lib/ffmpeg";
import { FONTS_DIR } from "../../src/lib/fonts";

const WIDTH = 320;
const HEIGHT = 180;
const FPS = 25;
const DURATION = 1;
const dataDir = process.env.MONTAGE_DATA_DIR || "";

/** Génère un média de test avec ffmpeg (lavfi). */
async function fixture(target: string, args: string[]) {
  const res = await run([FFMPEG, "-hide_banner", "-nostdin", "-y", ...args, target], { timeoutMs: 60000 });
  if (res.code !== 0) throw new Error(`fixture ${path.basename(target)} : ${res.stderr.slice(-600)}`);
}

/** Extrait une image en RGB brut (pour vérifier la transparence réelle). */
async function frameRgb(file: string, at = 0.2): Promise<Uint8Array> {
  const target = path.join(dataDir, `frame-${Math.random().toString(36).slice(2, 7)}.raw`);
  const res = await run(
    [FFMPEG, "-hide_banner", "-nostdin", "-y", "-ss", at.toFixed(2), "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", target],
    { timeoutMs: 60000 }
  );
  if (res.code !== 0) throw new Error(`extraction d'image : ${res.stderr.slice(-400)}`);
  const data = new Uint8Array(await Bun.file(target).arrayBuffer());
  await fs.rm(target, { force: true });
  return data;
}

function pixel(data: Uint8Array, x: number, y: number, width = WIDTH) {
  const o = (y * width + x) * 3;
  return { r: data[o], g: data[o + 1], b: data[o + 2] };
}

/** Le vert saturé de l'écran : ce que la clé chromatique doit faire disparaître. */
function isKeyGreen({ r, g, b }: { r: number; g: number; b: number }) {
  return g > 200 && r < 60 && b < 60;
}

async function main() {
  // ffmpeg tourne dans le dossier des polices (écriture du .ass) : il doit exister
  await ensureDir(FONTS_DIR, `${FONTS_DIR}/ttf`);
  const project = await createProject("Fumée ffmpeg");

  // Vidéo principale : une mire (recadrage réel, pas un simple aplat).
  await fixture(`${mediaDir(project.id)}/clip.mp4`, [
    "-f", "lavfi", "-i", `testsrc=size=${WIDTH}x${HEIGHT}:rate=${FPS}:duration=${DURATION}`,
    "-pix_fmt", "yuv420p", "-r", String(FPS),
  ]);
  // Incrustation « fond vert » : un sujet orange sur un écran vert.
  await fixture(`${mediaDir(project.id)}/screen.mp4`, [
    "-f", "lavfi", "-i", `color=c=0x00ff00:s=160x120:r=${FPS}:d=${DURATION}`,
    "-vf", "drawbox=x=50:y=35:w=60:h=50:color=0xff8844@1:t=fill",
    "-pix_fmt", "yuv420p", "-r", String(FPS),
  ]);
  // Voix témoin.
  await fixture(`${buildDir(project.id)}/voice.wav`, [
    "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${DURATION}`,
    "-ac", "2", "-c:a", "pcm_s16le",
  ]);

  const now = Date.now();
  project.sources = [
    {
      id: "src_clip",
      kind: "video",
      name: "clip.mp4",
      file: "clip.mp4",
      duration: DURATION,
      width: WIDTH,
      height: HEIGHT,
      fps: FPS,
      origin: "upload",
      createdAt: now,
    },
    {
      id: "src_screen",
      kind: "video",
      name: "screen.mp4",
      file: "screen.mp4",
      duration: DURATION,
      width: 160,
      height: 120,
      fps: FPS,
      origin: "upload",
      // fond vert détouré au rendu (colorkey + despill)
      chroma: { enabled: true, color: "#00ff00", similarity: 0.3, blend: 0.1, despill: true },
      createdAt: now,
    },
  ];
  project.videoTrack = [
    { id: "clip_main", sourceId: "src_clip", keyword: "mire", start: 0, duration: DURATION, offset: 0, effect: defaultEffect(), createdAt: now },
  ];
  project.audioTracks = [];
  project.overlayLayers = [
    {
      id: "lyr_chroma",
      name: "Vidéo 2",
      hidden: false,
      clips: [
        {
          id: "ovl_chroma",
          sourceId: "src_screen",
          start: 0,
          duration: DURATION,
          offset: 0,
          // case fixe : les assertions de pixels restent valables
          box: { x: 0.05, y: 0.05, w: 0.4, h: 0.4 },
          fit: "cover",
          opacity: 1,
          rotation: 8,
          motion: defaultMotion(),
          fadeIn: 0,
          fadeOut: 0,
          // opacité animée → chemin geq (les filtres par pixel n'ont pas `t`)
          // et courbe de puissance propre à l'image clé d'arrivée
          keys: [
            { t: 0, box: { x: 0.05, y: 0.05, w: 0.4, h: 0.4 }, rotation: 8, opacity: 1 },
            { t: DURATION, box: { x: 0.05, y: 0.05, w: 0.4, h: 0.4 }, rotation: 8, opacity: 0.6, ease: "power", power: 2.5 },
          ],
          ease: "smooth",
          audio: { mute: true, gain: 1 },
          createdAt: now,
        },
      ],
    },
    {
      id: "lyr_moving",
      name: "Vidéo 3",
      hidden: false,
      clips: [
        {
          id: "ovl_moving",
          sourceId: "src_screen",
          start: 0,
          duration: DURATION,
          offset: 0,
          box: { ...defaultBox(), w: 0.2, h: 0.2 },
          fit: "contain",
          opacity: 0.9,
          rotation: 0,
          motion: defaultMotion(),
          fadeIn: 0.1,
          fadeOut: 0.1,
          // position **et** taille animées → scale eval=frame + x/y dépendant du
          // temps, avec une image clé intermédiaire en maintien puis saut
          keys: [
            { t: 0, box: { x: 0.7, y: 0.6, w: 0.2, h: 0.2 }, rotation: -10, opacity: 0.4 },
            { t: DURATION / 2, box: { x: 0.62, y: 0.68, w: 0.24, h: 0.24 }, rotation: 0, opacity: 0.7, ease: "hold" },
            { t: DURATION, box: { x: 0.5, y: 0.7, w: 0.3, h: 0.3 }, rotation: 10, opacity: 0.9 },
          ],
          ease: "linear",
          audio: { mute: true, gain: 1 },
          createdAt: now,
        },
      ],
    },
  ];
  project.texts = [];
  project.voice.build = {
    sourceId: "src_clip",
    duration: DURATION,
    segments: [],
    peaks: [],
    peaksBuckets: 0,
    audioFile: "voice.wav",
    wavFile: "voice.wav",
    stats: { meanDb: -20, peakDb: -6 },
    builtAt: now,
    hash: "fumee",
  };
  await saveProject(project);

  const output = await renderMontage(project, { width: WIDTH, height: HEIGHT, fps: FPS, crf: 30, normalize: false });
  const file = path.join(buildDir(project.id), output.file);
  const stat = await fs.stat(file);

  const probe = await run([FFPROBE, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", file]);
  const info = JSON.parse(probe.stdout || "{}");
  const streams: any[] = info.streams || [];
  const video = streams.find((s) => s.codec_type === "video");

  // Contrôle : la fixture est bien verte là où l'on vérifie la transparence,
  // sinon l'assertion ne prouverait rien.
  const source = await frameRgb(path.join(mediaDir(project.id), "screen.mp4"), 0.2);
  const rgb = await frameRgb(file, 0.2);

  console.log(
    `SMOKE ${JSON.stringify({
      bytes: stat.size,
      width: video?.width ?? 0,
      height: video?.height ?? 0,
      duration: Number(info.format?.duration ?? 0),
      hasVideo: streams.some((s) => s.codec_type === "video"),
      hasAudio: streams.some((s) => s.codec_type === "audio"),
      sourcePixel: pixel(source, 5, 5, 160),
      backgroundPixel: pixel(rgb, 21, 14),
      subjectPixel: pixel(rgb, 80, 45),
    })}`
  );
  process.exit(0);
}

main().catch((error) => {
  console.error(`fixture échouée : ${error instanceof Error ? error.stack || error.message : String(error)}`);
  process.exit(1);
});
