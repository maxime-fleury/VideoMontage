import { badRequest, clamp, json, slug } from "../lib/util";
import { deleteSourceFile, saveProject, type AudioTrack } from "../lib/store";
import { renderMontage } from "../lib/ffmpeg";
import { createJob, failJob, finishJob, isCancelled, runHeavyJob, updateJob } from "../lib/jobs";
import { defaultSubtitles, subtitleLines, SUBTITLE_PRESETS } from "../lib/subtitles";
import { readBody } from "../lib/http";
import { cleanupPartialOutput, serialize } from "../lib/projectview";
import type { ProjectRouteCtx } from "./types";

/** Sous-titres, export du montage et suppression de source. */
export async function handleMontage(ctx: ProjectRouteCtx): Promise<Response | null> {
  const { req, parts, method, project, pid } = ctx;
  const [, , , c, d] = parts;

  // --- sous-titres --------------------------------------------------------
  if (c === "subtitles" && method === "GET") {
    const style = { ...defaultSubtitles(), ...(project.subtitles || {}) };
    const lines = project.transcript ? subtitleLines(project, style.maxWordsPerLine) : [];
    return json({ subtitles: style, lines, presets: SUBTITLE_PRESETS });
  }

  // --- export -------------------------------------------------------------
  if (c === "export" && method === "POST") {
    const body = await readBody<{
      fileName?: string;
      width?: number;
      height?: number;
      fps?: number;
      crf?: number;
      normalize?: boolean;
    }>(req);
    if (!project.voice.build) return badRequest("Compile d'abord la piste voix");
    const job = createJob("export", "Rendu du montage");
    const opts = {
      fileName: body.fileName || `${slug(project.name)}.mp4`,
      width: clamp(Number(body.width) || project.output.width, 240, 3840),
      height: clamp(Number(body.height) || project.output.height, 240, 2160),
      fps: clamp(Number(body.fps) || project.output.fps, 12, 60),
      crf: clamp(Number(body.crf ?? project.output.crf), 12, 32),
      normalize: body.normalize ?? project.output.normalize,
    };
    project.output = { ...project.output, width: opts.width, height: opts.height, fps: opts.fps, crf: opts.crf, normalize: !!opts.normalize };
    await saveProject(project);
    (async () => {
      await runHeavyJob(job.id, async () => {
        const result = await renderMontage(project, opts, (p, msg) => updateJob(job.id, { progress: p, message: msg || "Rendu…" }));
        finishJob(job.id, result, "Rendu terminé");
      });
    })().catch(async (e) => {
      // un rendu interrompu laisse un MP4 tronqué : on le supprime
      await cleanupPartialOutput(pid, opts.fileName);
      if (!isCancelled(job.id)) failJob(job.id, e instanceof Error ? e.message : String(e));
    });
    return json({ job: job.id });
  }

  // --- sources ------------------------------------------------------------
  if (c === "sources" && d && method === "DELETE") {
    const source = project.sources.find((s) => s.id === d);
    if (!source) return badRequest("Source introuvable");
    project.sources = project.sources.filter((s) => s.id !== d);
    project.videoTrack = project.videoTrack.filter((clip) => clip.sourceId !== d);
    project.overlayLayers = (project.overlayLayers || []).map((layer) => ({
      ...layer,
      clips: layer.clips.filter((clip) => clip.sourceId !== d),
    }));
    project.audioTracks = project.audioTracks
      .map((track) => ({ ...track, clips: track.clips.filter((clip) => clip.sourceId !== d) }))
      .filter(Boolean) as AudioTrack[];
    if (project.voice.sourceId === d) {
      project.voice.sourceId = undefined;
      project.voice.build = undefined;
      project.transcript = undefined;
    }
    await saveProject(project);
    await deleteSourceFile(pid, source);
    return json({ project: serialize(project) });
  }

  return null;
}

