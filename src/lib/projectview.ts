import fs from "node:fs/promises";
import { buildDir, clamp, mediaDir } from "./util";
import { montageDuration, saveProject, type Project } from "./store";
import { analyzeNoiseFloor, compileVoice, sanitizeFileName, type NoiseAnalysis } from "./ffmpeg";

/**
 * Supprime l'export partiel laissé par un rendu interrompu. Le nom subit les
 * mêmes transformations que dans renderMontage (sinon on ne supprime rien).
 */
export async function cleanupPartialOutput(pid: string, fileName: string) {
  const name = sanitizeFileName(fileName);
  const full = /\.[a-z0-9]+$/i.test(name) ? name : `${name}.mp4`;
  await fs.rm(`${buildDir(pid)}/${full}`, { force: true }).catch(() => {});
}

/** Projet renvoyé au navigateur : URLs des médias + durée du montage. */
export function serialize(project: Project) {
  return {
    ...project,
    sources: project.sources.map((s) => ({ ...s, url: `/media/${project.id}/${encodeURIComponent(s.file)}` })),
    voice: {
      ...project.voice,
      build: project.voice.build
        ? {
            ...project.voice.build,
            audioUrl: `/media/${project.id}/${encodeURIComponent(project.voice.build.audioFile)}?v=${project.voice.build.builtAt}`,
          }
        : undefined,
    },
    montage: montageDuration(project),
  };
}

/** Compile la voix et enregistre. Renvoie le projet + éventuellement une erreur non bloquante. */
export async function recompile(project: Project, warnings: string[] = []) {
  if (!project.voice.sourceId) return;
  try {
    const build = await compileVoice(project);
    project.voice.build = build;
    // la transcription ne correspond plus au nouveau montage
    if (project.transcript && project.transcript.hash !== build.hash) {
      warnings.push("La transcription date d'avant tes dernières modifications — relance-la si besoin.");
    }
    await saveProject(project);
  } catch (e) {
    // une annulation ne doit pas être avalée comme un simple avertissement
    if (e instanceof Error && e.name === "RunCancelled") throw e;
    warnings.push(e instanceof Error ? e.message : String(e));
  }
}

/**
 * Détermine le seuil de silence à utiliser : mesure du plancher de bruit si « auto »
 * (ou rien) est demandé, sinon valeur manuelle bornée.
 */
export async function resolveSilenceThreshold(
  file: string,
  requested?: number | "auto"
): Promise<{ thresholdDb: number; auto: boolean; noise: NoiseAnalysis | null }> {
  const auto = requested === undefined || requested === null || requested === "auto";
  if (!auto) return { thresholdDb: clamp(Number(requested), -80, -10), auto: false, noise: null };
  const noise = await analyzeNoiseFloor(file);
  return { thresholdDb: noise.suggestedThresholdDb, auto: true, noise };
}
