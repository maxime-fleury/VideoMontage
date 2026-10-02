import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Test de fumée du rendu ffmpeg.
 *
 * La fixture (`tests/smoke/render-fixture.ts`) tourne dans **un processus à
 * part**, avec un `MONTAGE_DATA_DIR` temporaire : le projet de test ne peut donc
 * jamais atterrir dans le vrai `data/`. Voir l'en-tête de la fixture.
 *
 * Le but n'est pas de juger l'image mais de garantir que la chaîne de filtres
 * (colorkey, despill, geq/N, scale eval=frame, rotate, libass) reste exécutable
 * quand on la modifie.
 */

const DATA_DIR = path.join(os.tmpdir(), `montagevideo-render-${Date.now()}`);
const FIXTURE = path.join(import.meta.dir, "smoke", "render-fixture.ts");

type Smoke = {
  bytes: number;
  width: number;
  height: number;
  duration: number;
  hasVideo: boolean;
  hasAudio: boolean;
  sourcePixel: { r: number; g: number; b: number };
  backgroundPixel: { r: number; g: number; b: number };
  subjectPixel: { r: number; g: number; b: number };
};

let skipReason = "";
let smoke: Smoke | null = null;

/** Le vert saturé de l'écran : ce que la clé chromatique doit faire disparaître. */
const isKeyGreen = ({ r, g, b }: { r: number; g: number; b: number }) => g > 200 && r < 60 && b < 60;

beforeAll(async () => {
  const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
  const probe = Bun.spawnSync([ffmpeg, "-version"], { stdout: "pipe", stderr: "pipe" });
  if (probe.exitCode !== 0) {
    skipReason = `ffmpeg introuvable (${ffmpeg})`;
    return;
  }
  await fs.mkdir(DATA_DIR, { recursive: true });
  const proc = Bun.spawn([process.execPath, "run", FIXTURE], {
    env: { ...process.env, MONTAGE_DATA_DIR: DATA_DIR },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`la fixture de rendu a échoué (code ${code}) :\n${(stdout + stderr).slice(-3000)}`);
  }
  const line = stdout.split(/\r?\n/).find((row) => row.startsWith("SMOKE "));
  if (!line) throw new Error(`sortie inattendue de la fixture :\n${(stdout + stderr).slice(-2000)}`);
  smoke = JSON.parse(line.slice("SMOKE ".length)) as Smoke;
}, 180000);

afterAll(async () => {
  await fs.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
});

describe("rendu ffmpeg de bout en bout (1 s)", () => {
  test("le rendu se termine et produit un fichier lisible", () => {
    if (skipReason) return;
    expect(smoke).not.toBeNull();
    expect(smoke!.bytes).toBeGreaterThan(1000);
    expect(smoke!.hasVideo).toBe(true);
    expect(smoke!.hasAudio).toBe(true);
    expect(smoke!.width).toBe(320);
    expect(smoke!.height).toBe(180);
    // durée montée respectée (généreuse : l'encodage peut rendre une image de plus)
    expect(smoke!.duration).toBeGreaterThan(0.85);
    expect(smoke!.duration).toBeLessThan(1.4);
  });

  test("la clé chromatique rend le fond vert transparent, sans effacer le sujet", () => {
    if (skipReason) return;
    expect(smoke).not.toBeNull();
    // contrôle : sans vert dans la source, l'assertion suivante ne prouverait rien
    expect(isKeyGreen(smoke!.sourcePixel)).toBe(true);
    // le fond vert de l'incrustation a disparu (le pixel montre la vidéo principale,
    // jamais un vert saturé à l'écran)
    expect(isKeyGreen(smoke!.backgroundPixel)).toBe(false);
    // le sujet orange de l'incrustation, lui, est bien composité
    expect(smoke!.subjectPixel.r).toBeGreaterThan(150);
    expect(smoke!.subjectPixel.g).toBeGreaterThan(100);
    expect(smoke!.subjectPixel.b).toBeLessThan(140);
  });
});
