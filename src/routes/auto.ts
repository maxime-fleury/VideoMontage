import { clamp, json, newId, slug } from "../lib/util";
import { getProject, saveProject, sourcePath, type AutoState, type AutoStepId, type Source, type VideoClip } from "../lib/store";
import { detectSilences, mergeRanges, renderMontage, sanitizeFileName } from "../lib/ffmpeg";
import {
  createJob,
  failJob,
  finishJob,
  isCancelled,
  runHeavyJob,
  setCheckpoint,
  updateJob,
} from "../lib/jobs";
import { RunCancelled } from "../lib/util";
import { transcribe, whisperStatus } from "../lib/whisper";
import { downloadImage, searchImages } from "../lib/images";
import { buildAutoSlots, pickKeyword, type AutoSlot } from "../lib/keywords";
import { defaultSubtitles } from "../lib/subtitles";
import { readBody } from "../lib/http";
import { cleanupPartialOutput, recompile, resolveSilenceThreshold, serialize } from "../lib/projectview";
import type { ProjectRouteCtx } from "./types";

/** Montage automatique simple (illustrations) et montage complet à points de contrôle. */
export async function handleAuto(ctx: ProjectRouteCtx): Promise<Response | null> {
  const { parts } = ctx;
  const [, , , c] = parts;
  if (c === "auto") return autoMontage(ctx);
  if (c === "auto-full") return autoFull(ctx);
  return null;
}

/** Erreur d'annulation : traversée des boucles sans être avalée par les catch locaux. */
function rethrowIfCancelled(error: unknown) {
  if (error instanceof RunCancelled) throw error;
  if (error instanceof Error && error.name === "RunCancelled") throw error;
}

/**
 * Lance le corps d'une tâche : l'erreur est enregistrée sauf si elle vient d'une
 * annulation. Le travail lourd est protégé à l'intérieur (voir runHeavyJob).
 */
function launch(jobId: string, task: () => Promise<void>) {
  (async () => {
    await task();
  })().catch((e) => {
    if (!isCancelled(jobId)) failJob(jobId, e instanceof Error ? e.message : String(e));
  });
}

/** Même chose, mais toute la tâche est un seul travail lourd. */
function launchHeavy(jobId: string, task: () => Promise<void>) {
  (async () => {
    await runHeavyJob(jobId, task);
  })().catch((e) => {
    if (!isCancelled(jobId)) failJob(jobId, e instanceof Error ? e.message : String(e));
  });
}

// ---------------------------------------------------------------------------
// Montage automatique simple : une illustration par passage illustrable
// ---------------------------------------------------------------------------

async function autoMontage({ req, parts, project, pid }: ProjectRouteCtx): Promise<Response> {
  void parts;
  const body = await readBody<{
    maxClips?: number;
    minDuration?: number;
    provider?: string;
    transitions?: boolean;
    kenBurns?: boolean;
    subtitles?: boolean;
    replace?: boolean;
    variants?: number;
    slots?: { start?: number; end?: number; keyword?: string }[];
  }>(req);
  const job = createJob("auto-montage", "Montage automatique");

  // tout le montage est un seul travail lourd : une seule génération à la fois
  launchHeavy(job.id, async () => {
    if (!project.transcript) throw new Error("Lance d'abord la transcription Whisper");
    if (!project.voice.build) throw new Error("Compile d'abord la piste voix");
    const maxClips = clamp(Number(body.maxClips ?? 30), 1, 120);
    const minDuration = clamp(Number(body.minDuration ?? 2.6), 1, 20);
    const provider = body.provider || "web";
    const withTransitions = body.transitions !== false;
    const withKenBurns = body.kenBurns !== false;
    const variants = clamp(Number(body.variants ?? 1), 1, 3);
    const total = project.voice.build.duration;

    let slots: AutoSlot[] = [];
    if (Array.isArray(body.slots) && body.slots.length) {
      // liste de mots-clés validée/éditée par l'utilisateur
      slots = body.slots
        .map((slot) => ({
          start: Math.max(0, Number(slot.start) || 0),
          end: Math.max(0, Number(slot.end) || 0),
          keywords: [String(slot.keyword || "").trim()],
          scores: [1],
          top: String(slot.keyword || "").trim(),
        }))
        .filter((slot) => slot.keywords[0])
        .sort((a, b) => a.start - b.start);
    } else {
      slots = buildAutoSlots(project, minDuration);
    }
    if (!slots.length) throw new Error("Aucun mot-clé exploitable dans la transcription");
    // garder les créneaux les mieux notés, répartis sur toute la narration
    if (slots.length > maxClips) {
      const keep = new Set<number>();
      const step = slots.length / maxClips;
      for (let i = 0; i < maxClips; i++) keep.add(Math.round(i * step));
      slots = slots.filter((_, i) => keep.has(i));
    }

    const fresh = await getProject(pid);
    if (!fresh) throw new Error("Projet perdu");
    const newSources: Source[] = [];
    const clips: VideoClip[] = [];
    const used = new Set<string>();
    const resultCache = new Map<string, { url: string; thumb?: string; pageUrl?: string; provider: string }[]>();
    const reusable = new Map<string, Source>();
    for (const source of fresh.sources) {
      const keyword = String(source.meta?.keyword || "").toLowerCase();
      if (source.kind === "image" && keyword && !reusable.has(keyword)) reusable.set(keyword, source);
    }

    const transitionDuration = withTransitions ? 0.7 : 0;
    for (let i = 0; i < slots.length; i++) {
      if (isCancelled(job.id)) throw new RunCancelled();
      const slot = slots[i];
      const start = Math.max(0, Math.min(i === 0 ? Math.max(0, slot.start - 0.4) : slot.start, total));
      const nextStart = i + 1 < slots.length ? Math.max(slots[i + 1].start, start + 1) : total;
      const end = Math.min(total, Math.max(nextStart, slot.end + 0.4));
      const duration = Math.max(1, end - start);
      updateJob(job.id, {
        progress: (i / slots.length) * 0.95,
        message: `Illustration ${i + 1}/${slots.length} — ${Math.round(start)}s → ${Math.round(end)}s`,
      });

      let placed = false;
      for (let attempt = 0; attempt < slot.keywords.length && !placed; attempt++) {
        if (isCancelled(job.id)) throw new RunCancelled();
        const keyword = attempt === 0 ? pickKeyword(slot, used) : slot.keywords[attempt];
        if (!keyword) continue;
        const key = keyword.toLowerCase();
        try {
          updateJob(job.id, { message: `Recherche « ${keyword} »…` });
          let results = resultCache.get(key);
          if (!results) {
            const search = await searchImages(keyword, { provider, count: 10 });
            results = search.results.slice(0, Math.max(4, variants)).map((r) => ({
              url: r.url,
              thumb: r.thumb,
              pageUrl: r.pageUrl,
              provider: r.provider,
            }));
            if (results.length) resultCache.set(key, results);
          }
          if (!results?.length) continue;

          // une ou plusieurs illustrations pour ce mot-clé
          const wanted = Math.min(variants, results.length);
          const pieces: { source: Source }[] = [];
          for (let v = 0; v < wanted; v++) {
            const candidate = results[v];
            try {
              const source = await downloadImage(fresh, {
                url: candidate.url,
                fallbackUrl: candidate.thumb,
                referer: candidate.pageUrl,
                keyword,
                provider: candidate.provider,
              });
              newSources.push(source);
              reusable.set(key + (v || ""), source);
              pieces.push({ source });
            } catch (e) {
              rethrowIfCancelled(e);
              updateJob(job.id, { log: `« ${keyword} » (${v + 1}) indisponible : ${e instanceof Error ? e.message : e}` });
            }
          }
          if (!pieces.length) continue;
          used.add(key);
          used.add(key.split(" ")[0]);
          const slice = duration / pieces.length;
          pieces.forEach((piece, v) => {
            const pieceStart = start + v * slice;
            const isLastPiece = i + 1 >= slots.length && v === pieces.length - 1;
            clips.push({
              id: newId("clip"),
              sourceId: piece.source.id,
              keyword,
              start: pieceStart,
              duration: isLastPiece ? slice : slice + transitionDuration,
              offset: 0,
              effect: {
                fadeIn: 0.4,
                fadeOut: isLastPiece ? 0.8 : 0,
                kenBurns: withKenBurns,
                zoomFrom: 1,
                zoomTo: 1.12,
                transition: { type: withTransitions ? "dissolve" : "fade-black", duration: transitionDuration },
              },
              createdAt: Date.now(),
            });
          });
          placed = true;
        } catch (e) {
          rethrowIfCancelled(e);
          updateJob(job.id, { log: `« ${keyword} » indisponible : ${e instanceof Error ? e.message : e}` });
        }
      }
      if (!placed) updateJob(job.id, { log: `Créneau ${Math.round(start)}s : aucune image trouvée` });
    }

    const latest = await getProject(pid);
    if (!latest) throw new Error("Projet perdu");
    latest.sources.push(...newSources);
    latest.videoTrack =
      body.replace === false ? [...latest.videoTrack, ...clips].sort((x, y) => x.start - y.start) : clips.sort((x, y) => x.start - y.start);
    if (body.subtitles && latest.transcript) {
      latest.subtitles = { ...(latest.subtitles || defaultSubtitles()), enabled: true };
    }
    await saveProject(latest);
    finishJob(job.id, { project: serialize(latest), clips: clips.length }, `${clips.length} illustrations placées`);
  });

  return json({ job: job.id });
}

// ---------------------------------------------------------------------------
// Montage automatique complet (points de contrôle reprenables)
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

async function autoFull({ req, project, pid }: ProjectRouteCtx): Promise<Response> {
  const body = await readBody<{
    pause?: boolean;
    denoise?: boolean;
    threshold?: number | "auto";
    minSilence?: number;
    factor?: number;
    model?: string;
    language?: string;
    maxClips?: number;
    minDuration?: number;
    provider?: string;
    transitions?: boolean;
    kenBurns?: boolean;
    subtitles?: boolean;
    replace?: boolean;
    crf?: number;
  }>(req);
  const job = createJob("auto-full", "Montage automatique complet");
  const pause = body.pause !== false;
  let factor = clamp(Number(body.factor ?? 100), 2, 100);
  void project;

  launch(job.id, async () => {
    const report: string[] = [];
    const auto: AutoState = { jobId: job.id, completed: [], report, options: { ...body }, updatedAt: Date.now() };
    const log = (line: string) => {
      report.push(line);
      updateJob(job.id, { log: line });
    };
    const saveAuto = async (patch: Partial<AutoState> = {}) => {
      Object.assign(auto, patch, { updatedAt: Date.now() });
      const fresh = await getProject(pid);
      if (fresh) {
        fresh.auto = { ...auto };
        await saveProject(fresh);
      }
      return fresh;
    };
    /** Point de contrôle : met la tâche en attente si les pauses sont actives. */
    const checkpoint = async (
      id: AutoStepId,
      label: string,
      message: string,
      payload: unknown,
      progress: number
    ): Promise<any> => {
      await saveAuto({ stage: id });
      if (!pause) {
        updateJob(job.id, { progress, message });
        return {};
      }
      return setCheckpoint(job.id, { id, label, message, payload, actions: ["resume", "cancel"] }, progress);
    };
    const cancelled = (answer: any) => answer?.cancelled || answer?.action === "cancel";

    // 1. Silences : seuil auto, détection, accélération, recompilation de la voix.
    updateJob(job.id, { progress: 0.03, message: "Analyse du plancher de bruit et des silences…" });
    let fresh = await getProject(pid);
    if (!fresh) throw new Error("Projet perdu");
    const voiceSource = fresh.sources.find((s) => s.id === fresh.voice.sourceId);
    if (!voiceSource) throw new Error("Aucune piste voix : enregistre ou importe d'abord ta voix");
    if (body.denoise) {
      fresh.voice.edits.denoise = { ...fresh.voice.edits.denoise, mode: "auto", reduction: 12 };
      log("Débruitage automatique activé (afftdn)");
    }
    let threshold: number | "auto" = body.threshold ?? "auto";
    let minSilence = clamp(Number(body.minSilence ?? 0.35), 0.1, 5);
    let silencesFound = 0;
    let savedSeconds = 0;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (isCancelled(job.id)) throw new RunCancelled();
      let thresholdDb = 0;
      let isAuto = false;
      let noise: Awaited<ReturnType<typeof resolveSilenceThreshold>>["noise"] = null;
      let detected: { start: number; end: number }[] = [];
      // le travail lourd est isolé : la place est rendue pendant les pauses utilisateur
      const warnings = await runHeavyJob(job.id, async () => {
        const analysis = await resolveSilenceThreshold(sourcePath(pid, voiceSource), threshold);
        thresholdDb = analysis.thresholdDb;
        isAuto = analysis.auto;
        noise = analysis.noise;
        detected = await detectSilences(sourcePath(pid, voiceSource), thresholdDb, minSilence);
        fresh!.voice.edits.ffwd = mergeRanges(detected);
        fresh!.voice.edits.ffwdFactor = factor;
        await saveProject(fresh!);
        const collected: string[] = [];
        await recompile(fresh!, collected);
        return collected;
      });
      warnings.forEach((w) => log(`⚠️ ${w}`));
      silencesFound = detected.length;
      savedSeconds = detected.reduce((acc, s) => acc + (s.end - s.start) * (1 - 1 / factor), 0);
      log(
        `Silences : ${detected.length} zones accélérées ×${factor} → ${savedSeconds.toFixed(1)} s gagnées` +
          ` (seuil ${thresholdDb} dB${isAuto ? ", auto" : ""})`
      );
      const answer = await checkpoint(
        "silences",
        "Silences nettoyés",
        `${detected.length} silences accélérés ×${factor} — ${savedSeconds.toFixed(1)} s gagnées.`,
        {
          silences: detected.length,
          saved: Number(savedSeconds.toFixed(1)),
          thresholdDb,
          auto: isAuto,
          minSilence,
          factor,
          duration: fresh.voice.build?.duration || 0,
          analysis: noise,
          hasDenoise: body.denoise === true,
        },
        0.1
      );
      if (cancelled(answer)) throw new RunCancelled("Montage automatique annulé après le nettoyage des silences");
      if (answer?.adjust) {
        const adjust = answer.adjust as { threshold?: number | "auto"; factor?: number; minSilence?: number };
        if (adjust.threshold !== undefined) threshold = adjust.threshold === "auto" ? "auto" : clamp(Number(adjust.threshold), -80, -10);
        if (adjust.factor !== undefined) factor = clamp(Number(adjust.factor), 2, 100);
        if (adjust.minSilence !== undefined) minSilence = clamp(Number(adjust.minSilence), 0.1, 5);
        log("Réglages de silence ajustés — nouvelle analyse");
        continue;
      }
      break;
    }
    void silencesFound;
    fresh = await saveAuto({ completed: [...auto.completed, "silences"], stage: "transcription" });
    if (!fresh) throw new Error("Projet perdu");

    // 2. Transcription Whisper.
    const whisper = await whisperStatus();
    if (!whisper.binary || !whisper.models.some((m) => m.installed)) {
      throw new Error("Whisper n'est pas installé — ouvre ⚙️ Réglages");
    }
    const transcribed = await runHeavyJob(job.id, async () => {
      updateJob(job.id, { progress: 0.14, message: "Transcription Whisper…" });
      return transcribe(fresh!, { model: body.model, language: body.language }, (p, message) =>
        updateJob(job.id, { progress: 0.14 + p * 0.2, message: message || "Transcription…" })
      );
    });
    fresh = await getProject(pid);
    if (!fresh) throw new Error("Projet perdu");
    fresh.transcript = transcribed;
    await saveProject(fresh);
    log(`Transcription : ${transcribed.segments.length} segments (${transcribed.language})`);
    await saveAuto({ completed: [...auto.completed, "transcription"], stage: "keywords" });

    // 3. Mots-clés : détection puis validation par l'utilisateur.
    const minDuration = clamp(Number(body.minDuration ?? 3.2), 1.5, 20);
    const maxClips = clamp(Number(body.maxClips ?? 30), 1, 120);
    let slots = buildAutoSlots(fresh, minDuration);
    if (!slots.length) throw new Error("Aucun mot-clé exploitable dans la transcription");
    if (slots.length > maxClips) {
      const keep = new Set<number>();
      const step = slots.length / maxClips;
      for (let i = 0; i < maxClips; i++) keep.add(Math.round(i * step));
      slots = slots.filter((_, i) => keep.has(i));
    }
    log(`Mots-clés : ${slots.length} passages illustrables repérés`);
    const keywordsAnswer = await checkpoint(
      "keywords",
      "Mots-clés validés",
      `${slots.length} passages illustrables repérés. Corrige la liste si besoin, puis continue.`,
      {
        slots: slots.map((slot, index) => ({
          index,
          start: Number(slot.start.toFixed(2)),
          end: Number(slot.end.toFixed(2)),
          keyword: slot.top,
          alternatives: slot.keywords,
          scores: slot.scores,
        })),
        provider: body.provider || "web",
      },
      0.38
    );
    if (cancelled(keywordsAnswer)) throw new RunCancelled("Annulé avant l'illustration");
    if (Array.isArray(keywordsAnswer?.slots) && keywordsAnswer.slots.length) {
      slots = keywordsAnswer.slots
        .filter((slot: any) => String(slot?.keyword || "").trim())
        .map((slot: any) => ({
          start: Math.max(0, Number(slot.start) || 0),
          end: Math.max(0, Number(slot.end) || 0),
          keywords: [String(slot.keyword).trim()],
          scores: [1],
          top: String(slot.keyword).trim(),
        }))
        .sort((a, b) => a.start - b.start);
      log(`Liste validée : ${slots.length} illustrations à chercher`);
    }
    await saveAuto({ completed: [...auto.completed, "keywords"], stage: "illustrations" });

    // 4. Illustrations : recherche d'une image par passage.
    const provider = body.provider || "web";
    const withTransitions = body.transitions !== false;
    const withKenBurns = body.kenBurns !== false;
    const transitionDuration = withTransitions ? 0.7 : 0;
    const totalDuration = fresh.voice.build?.duration || 0;
    const newSources: Source[] = [];
    const newClips: VideoClip[] = [];
    const used = new Set<string>();
    const reusable = new Map<string, Source>();
    for (const source of fresh.sources) {
      const keyword = String(source.meta?.keyword || "").toLowerCase();
      if (source.kind === "image" && keyword && !reusable.has(keyword)) reusable.set(keyword, source);
    }
    const buildClip = (source: Source, keyword: string, start: number, duration: number, last: boolean): VideoClip => ({
      id: newId("clip"),
      sourceId: source.id,
      keyword,
      start,
      duration: last ? duration : duration + transitionDuration,
      offset: 0,
      effect: {
        fadeIn: 0.4,
        fadeOut: last ? 0.8 : 0,
        kenBurns: withKenBurns,
        zoomFrom: 1,
        zoomTo: 1.12,
        transition: { type: withTransitions ? "dissolve" : "fade-black", duration: transitionDuration },
      },
      createdAt: Date.now(),
    });
    // Phase réseau (téléchargements d'images) : pas de place de travail lourd
    // réservée (ce n'est ni du CPU ni du disque), mais chaque tour vérifie
    // l'annulation et l'état est sauvegardé à la fin.
    for (let i = 0; i < slots.length; i++) {
      if (isCancelled(job.id)) throw new RunCancelled();
      const slot = slots[i];
      const start = Math.max(0, Math.min(i === 0 ? Math.max(0, slot.start - 0.4) : slot.start, totalDuration));
      const nextStart = i + 1 < slots.length ? Math.max(slots[i + 1].start, start + 1) : totalDuration;
      const end = Math.min(totalDuration, Math.max(nextStart, slot.end + 0.4));
      const duration = Math.max(1, end - start);
      const last = i === slots.length - 1;
      updateJob(job.id, {
        progress: 0.42 + (i / Math.max(1, slots.length)) * 0.24,
        message: `Illustration ${i + 1}/${slots.length} — « ${slot.top} »`,
      });
      let placed = false;
      for (let attempt = 0; attempt < slot.keywords.length && !placed; attempt++) {
        if (isCancelled(job.id)) throw new RunCancelled();
        const keyword = attempt === 0 ? pickKeyword(slot, used) : slot.keywords[attempt];
        if (!keyword) continue;
        const key = keyword.toLowerCase();
        try {
          const known = reusable.get(key);
          if (known) {
            newClips.push(buildClip(known, keyword, start, duration, last));
            used.add(key);
            placed = true;
            break;
          }
          const search = await searchImages(keyword, { provider, count: 8 });
          const candidate = search.results.find((r) => r?.url);
          if (!candidate) continue;
          const source = await downloadImage(fresh, {
            url: candidate.url,
            fallbackUrl: candidate.thumb,
            referer: candidate.pageUrl,
            keyword,
            provider: candidate.provider,
          });
          newSources.push(source);
          reusable.set(key, source);
          used.add(key);
          used.add(key.split(" ")[0]);
          newClips.push(buildClip(source, keyword, start, duration, last));
          placed = true;
        } catch (e) {
          rethrowIfCancelled(e);
          updateJob(job.id, { log: `« ${keyword} » indisponible : ${e instanceof Error ? e.message : e}` });
        }
      }
      if (!placed) updateJob(job.id, { log: `Créneau ${Math.round(start)}s : aucune image trouvée` });
    }

    let latest = await getProject(pid);
    if (!latest) throw new Error("Projet perdu");
    latest.sources.push(...newSources);
    latest.videoTrack =
      body.replace === false
        ? [...latest.videoTrack, ...newClips].sort((x, y) => x.start - y.start)
        : newClips.sort((x, y) => x.start - y.start);
    if (body.subtitles !== false && latest.transcript) {
      latest.subtitles = { ...(latest.subtitles || defaultSubtitles()), enabled: true };
      log("Sous-titres activés sur la transcription");
    }
    latest.auto = { ...auto, completed: [...auto.completed, "illustrations"], stage: "subtitles", updatedAt: Date.now() };
    await saveProject(latest);
    log(`Illustrations : ${newClips.length} clips placés (${newSources.length} nouveaux médias)`);

    // 5. Récapitulatif puis rendu final.
    const recap = {
      duration: Number((latest.voice.build?.duration || 0).toFixed(1)),
      clips: latest.videoTrack.length,
      overlays: (latest.overlayLayers || []).reduce((acc, layer) => acc + layer.clips.length, 0),
      texts: (latest.texts || []).length,
      subtitles: !!latest.subtitles?.enabled,
      sources: latest.sources.length,
      quality: latest.output.crf,
    };
    const confirm = await checkpoint(
      "export",
      "Prêt à exporter",
      "Tout est en place : vérifie le récapitulatif puis lance le rendu.",
      recap,
      0.68
    );
    if (cancelled(confirm)) throw new RunCancelled("Annulé avant l'export");
    const fileName =
      typeof confirm?.fileName === "string" && confirm.fileName.trim()
        ? sanitizeFileName(confirm.fileName.trim())
        : `${slug(latest.name)}.mp4`;
    const crf = clamp(Number(confirm?.crf ?? body.crf ?? latest.output.crf), 12, 32);
    latest.output = { ...latest.output, crf };
    await saveProject(latest);
    const rendered = await runHeavyJob(job.id, async () => {
      updateJob(job.id, { progress: 0.7, message: "Rendu du montage…" });
      return renderMontage(latest!, { fileName, crf, normalize: latest!.output.normalize }, (p, message) =>
        updateJob(job.id, { progress: 0.7 + p * 0.29, message: message || "Rendu…" })
      );
    }).catch(async (e) => {
      // rendu interrompu : le MP4 tronqué ne doit pas rester dans le dossier build
      await cleanupPartialOutput(pid, fileName);
      throw e;
    });
    log(`Export : ${rendered.file} — ${(rendered.duration / 60).toFixed(1)} min`);
    const finalProject = (await getProject(pid)) || latest;
    finalProject.auto = { ...auto, completed: [...auto.completed, "export"], stage: undefined, updatedAt: Date.now() };
    await saveProject(finalProject);
    finishJob(
      job.id,
      { project: serialize(finalProject), output: rendered, report },
      `Montage complet terminé — ${rendered.file} 🎬`
    );
  });

  return json({ job: job.id });
}
