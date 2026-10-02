import { badRequest, clamp, json, sanitizeText } from "../lib/util";
import { defaultEdits, getProject, saveProject, sourcePath } from "../lib/store";
import {
  buildSegments,
  detectSilences,
  mapOutToSource,
  measureRegion,
  mergeRanges,
} from "../lib/ffmpeg";
import { createJob, failJob, finishJob, isCancelled, runHeavyJob, updateJob } from "../lib/jobs";
import { readBody } from "../lib/http";
import { recompile, resolveSilenceThreshold, serialize } from "../lib/projectview";
import { cleanWordText } from "../lib/keywords";
import { transcribe } from "../lib/whisper";
import type { ProjectRouteCtx } from "./types";

const STOPWORDS_INLINE = new Set(
  `le la les un une des du de à au aux et ou donc car ni mais que qui quoi dont où en y il elle on nous vous ils elles ce cet cette ces mon ma mes ton ta tes son sa ses notre nos votre vos leur leurs pour par sans sous sur dans avec chez vers entre depuis pendant après avant contre est sont était étaient suis être avoir a ai as ont`.split(
    /\s+/
  )
);

/** Routes voix (coupes, silences, débruitage), transcription et mot-clé de clip. */
export async function handleVoice(ctx: ProjectRouteCtx): Promise<Response | null> {
  const { req, parts, url, method, project, pid } = ctx;
  const [, , , c, d] = parts;

  if (c === "voice") {
    if (d === "source" && method === "POST") {
      const body = await readBody<{ sourceId?: string }>(req);
      const source = project.sources.find((s) => s.id === body.sourceId);
      if (!source) return badRequest("Source introuvable");
      if (source.kind === "image") return badRequest("Une image ne peut pas être une piste voix");
      const existing = project.sources.find((s) => s.id === project.voice.sourceId);
      if (existing && existing.id !== source.id) {
        // on garde la source, mais on réinitialise le montage précédent
        project.voice.edits = defaultEdits();
      } else if (!project.voice.edits) {
        project.voice.edits = defaultEdits();
      }
      project.voice.sourceId = source.id;
      project.transcript = undefined;
      await saveProject(project);
      const warnings: string[] = [];
      await recompile(project, warnings);
      return json({ project: serialize(project), warnings });
    }

    if (d === "compile" && method === "POST") {
      const warnings: string[] = [];
      await recompile(project, warnings);
      await saveProject(project);
      return json({ project: serialize(project), warnings });
    }

    if (d === "detect" && method === "POST") {
      const body = await readBody<{ thresholdDb?: number | "auto"; minDuration?: number }>(req);
      const source = project.sources.find((s) => s.id === project.voice.sourceId);
      if (!source) return badRequest("Aucune piste voix");
      const analysis = await resolveSilenceThreshold(sourcePath(pid, source), body.thresholdDb);
      const thresholdDb = analysis.thresholdDb;
      const minDuration = clamp(Number(body.minDuration ?? 0.35), 0.1, 5);
      const silences = source.duration
        ? await detectSilences(sourcePath(pid, source), thresholdDb, minDuration)
        : [];
      const segments = project.voice.build?.segments ?? buildSegments(project.voice.edits, source.duration);
      const inOut = silences
        .map((s) => ({
          start: segments.find((seg) => s.start >= seg.srcStart && s.start <= seg.srcEnd)
            ? (() => {
                const seg = segments.find((g) => s.start >= g.srcStart && s.start <= g.srcEnd)!;
                return seg.outStart + (s.start - seg.srcStart) / seg.tempo;
              })()
            : null,
          end: (() => {
            const seg = segments.find((g) => s.end >= g.srcStart && s.end <= g.srcEnd);
            return seg ? seg.outStart + (s.end - seg.srcStart) / seg.tempo : null;
          })(),
        }))
        .filter((r) => r.start !== null && r.end !== null) as { start: number; end: number }[];
      return json({
        silences,
        inOut,
        total: silences.reduce((acc, s) => acc + (s.end - s.start), 0),
        savedAtX100: silences.reduce((acc, s) => acc + (s.end - s.start) * (1 - 1 / project.voice.edits.ffwdFactor), 0),
        thresholdDb,
        auto: analysis.auto,
        analysis: analysis.noise,
      });
    }

    if (d === "ffwd" && method === "POST") {
      const body = await readBody<{
        enabled?: boolean;
        thresholdDb?: number | "auto";
        minDuration?: number;
        factor?: number;
      }>(req);
      const source = project.sources.find((s) => s.id === project.voice.sourceId);
      if (!source) return badRequest("Aucune piste voix");
      const factor = clamp(Number(body.factor ?? project.voice.edits.ffwdFactor ?? 100), 2, 100);
      project.voice.edits.ffwdFactor = factor;
      if (body.enabled === false) {
        project.voice.edits.ffwd = [];
      } else {
        // même seuil (auto ou manuel) que celui affiché par la prévisualisation
        const { thresholdDb } = await resolveSilenceThreshold(sourcePath(pid, source), body.thresholdDb);
        const minDuration = clamp(Number(body.minDuration ?? 0.35), 0.1, 5);
        const silences = await detectSilences(sourcePath(pid, source), thresholdDb, minDuration);
        project.voice.edits.ffwd = mergeRanges(silences);
      }
      await saveProject(project);
      const warnings: string[] = [];
      await recompile(project, warnings);
      return json({ project: serialize(project), warnings });
    }

    if (d === "cut" && method === "POST") {
      const body = await readBody<{ start?: number; end?: number }>(req);
      const source = project.sources.find((s) => s.id === project.voice.sourceId);
      if (!source) return badRequest("Aucune piste voix");
      const segments = project.voice.build?.segments ?? buildSegments(project.voice.edits, source.duration);
      const start = clamp(Number(body.start ?? 0), 0, 1e9);
      const end = clamp(Number(body.end ?? 0), 0, 1e9);
      if (end - start < 0.01) return badRequest("Sélection trop courte");
      const sourceRanges = mapOutToSource(segments, start, end);
      project.voice.edits.cuts = mergeRanges([...project.voice.edits.cuts, ...sourceRanges]);
      await saveProject(project);
      const warnings: string[] = [];
      await recompile(project, warnings);
      return json({ project: serialize(project), warnings });
    }

    if (d === "denoise" && method === "POST") {
      const body = await readBody<{
        mode?: "none" | "auto" | "profile" | "rnnoise";
        reduction?: number;
        sample?: { start: number; end: number } | null;
      }>(req);
      const mode = body.mode || "none";
      project.voice.edits.denoise = {
        ...project.voice.edits.denoise,
        mode,
        reduction: clamp(Number(body.reduction ?? project.voice.edits.denoise.reduction ?? 12), 0.1, 97),
      };
      let measured: { rmsDb: number; peakDb: number } | null = null;
      if (mode === "profile") {
        const source = project.sources.find((s) => s.id === project.voice.sourceId);
        if (!source) return badRequest("Aucune piste voix");
        const segments = project.voice.build?.segments ?? buildSegments(project.voice.edits, source.duration);
        let range = body.sample || project.voice.edits.denoise.sample || null;
        if (range) {
          const srcRanges = mapOutToSource(segments, range.start, range.end);
          if (srcRanges.length) {
            const first = srcRanges[0];
            const last = srcRanges[srcRanges.length - 1];
            range = { start: first.start, end: last.end };
          }
        }
        if (!range) return badRequest("Sélectionne d'abord une zone de silence (blanc) dans la forme d'onde");
        measured = await measureRegion(sourcePath(pid, source), range);
        project.voice.edits.denoise.sample = range;
        project.voice.edits.denoise.floorDb = Math.round((measured.rmsDb - 2) * 10) / 10;
      }
      await saveProject(project);
      const warnings: string[] = [];
      await recompile(project, warnings);
      return json({ project: serialize(project), measured, warnings });
    }

    if (d === "normalize" && method === "POST") {
      const body = await readBody<{ enabled?: boolean }>(req);
      project.voice.edits.normalize = !!body.enabled;
      await saveProject(project);
      const warnings: string[] = [];
      await recompile(project, warnings);
      return json({ project: serialize(project), warnings });
    }

    if (d === "reset" && method === "POST") {
      // on garde la transcription (elle sera marquée comme obsolète par le hash du montage)
      project.voice.edits = defaultEdits();
      await saveProject(project);
      const warnings: string[] = [];
      await recompile(project, warnings);
      return json({ project: serialize(project), warnings });
    }

    if (d === "level" && method === "GET") {
      const source = project.sources.find((s) => s.id === project.voice.sourceId);
      if (!source) return badRequest("Aucune piste voix");
      const info = await measureRegion(sourcePath(pid, source), { start: 0, end: source.duration });
      return json({ level: info, build: project.voice.build?.stats });
    }
    return badRequest("Route voix inconnue", 404);
  }

  // --- transcription ------------------------------------------------------
  if (c === "transcribe" && method === "POST") {
    const body = await readBody<{ model?: string; language?: string }>(req);
    const job = createJob("transcribe", "Transcription Whisper");
    (async () => {
      await runHeavyJob(job.id, async () => {
        const transcript = await transcribe(project, { model: body.model, language: body.language }, (p, msg) =>
          updateJob(job.id, { progress: p, message: msg || "Transcription…" })
        );
        const fresh = await getProject(pid);
        if (fresh) {
          fresh.transcript = transcript;
          await saveProject(fresh);
        }
        finishJob(job.id, { segments: transcript.segments.length, language: transcript.language }, "Transcription terminée");
      });
    })().catch((e) => {
      if (!isCancelled(job.id)) failJob(job.id, e instanceof Error ? e.message : String(e));
    });
    return json({ job: job.id });
  }

  if (c === "transcript" && method === "GET") {
    return json({ transcript: project.transcript ?? null });
  }

  // --- édition de la transcription ---------------------------------------
  if (c === "transcript" && d === "edit" && method === "POST") {
    const body = await readBody<{ action?: string; segmentId?: string; index?: number; text?: string }>(req);
    if (!project.transcript) return badRequest("Pas de transcription");
    const segments = project.transcript.segments;
    const segment = segments.find((s) => s.id === body.segmentId);
    if (!segment) return badRequest("Segment introuvable");
    const action = body.action || "update-word";
    if (action === "delete-segment") {
      project.transcript.segments = segments.filter((s) => s.id !== segment.id);
    } else if (action === "delete-word") {
      segment.words.splice(Number(body.index) || 0, 1);
      segment.text = segment.words.map((w) => w.w).join(" ");
      if (!segment.words.length) project.transcript.segments = segments.filter((s) => s.id !== segment.id);
    } else {
      const index = Number(body.index);
      const word = segment.words[index];
      if (!word) return badRequest("Mot introuvable");
      const text = sanitizeText(String(body.text ?? word.w));
      if (!text) return badRequest("Texte vide");
      if (text !== word.w) word.edited = true;
      word.w = text;
      segment.text = segment.words.map((w) => w.w).join(" ");
    }
    await saveProject(project);
    return json({ project: serialize(project) });
  }

  // --- mot-clé d'un clip (pour proposer d'autres illustrations) ----------
  if (c === "clips" && d === "keyword" && method === "GET") {
    const clipId = url.searchParams.get("clipId") || "";
    const clip = project.videoTrack.find((x) => x.id === clipId);
    if (!clip) return badRequest("Clip introuvable", 404);
    let keyword = clip.keyword || "";
    if (!keyword) {
      const words = (project.transcript?.segments || [])
        .flatMap((s) => s.words.map((w) => ({ ...w, segId: s.id })))
        .filter((w) => w.s >= clip.start - 1.5 && w.s <= clip.start + clip.duration)
        .map((w) => cleanWordText(w.w))
        .filter((w) => w && !STOPWORDS_INLINE.has(w.toLowerCase()));
      keyword = words.sort((a, b) => b.length - a.length)[0] || "";
    }
    return json({ keyword });
  }

  return null;
}
