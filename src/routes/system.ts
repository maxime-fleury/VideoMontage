import { badRequest, json } from "../lib/util";
import { createJob, failJob, finishJob, updateJob } from "../lib/jobs";
import { readBody } from "../lib/http";
import { installRecommendedFonts, installFont, listFonts } from "../lib/fonts";
import { ffmpegAvailable } from "../lib/ffmpeg";
import { installRnnoise, installWhisper, whisperStatus } from "../lib/whisper";
import { proxyImage } from "../lib/images";
import { motionCatalog } from "../lib/motions";
import type { RouteCtx } from "./types";

/** Routes hors projet : /api/motions, /api/fonts, /api/imgproxy, /api/setup. */
export async function handleSystem({ req, parts, url, method }: RouteCtx): Promise<Response | null> {
  const [, a, b] = parts;

  if (a === "motions" && method === "GET") return json(motionCatalog());

  if (a === "fonts") {
    if (method === "GET") return json({ fonts: await listFonts() });
    if (method === "POST") {
      const body = await readBody<{ id?: string; all?: boolean }>(req);
      const job = createJob("fonts", "Téléchargement des polices");
      (async () => {
        if (body.all) {
          await installRecommendedFonts((p, message) => updateJob(job.id, { progress: p, message: message || "Polices…" }));
        } else {
          await installFont(body.id || "Outfit", (p, message) =>
            updateJob(job.id, { progress: p, message: message || "Téléchargement…" })
          );
        }
        finishJob(job.id, { fonts: await listFonts() }, "Polices installées");
      })().catch((e) => failJob(job.id, e instanceof Error ? e.message : String(e)));
      return json({ job: job.id });
    }
  }

  if (a === "imgproxy") {
    const target = url.searchParams.get("url");
    if (!target) return badRequest("url manquante");
    try {
      return await proxyImage(target, url.searchParams.get("referer") || undefined);
    } catch (e) {
      return badRequest(e instanceof Error ? e.message : String(e), 502);
    }
  }

  if (a === "setup") {
    if (b === "status" && method === "GET") {
      const whisper = await whisperStatus();
      return json({ ffmpeg: ffmpegAvailable(), whisper });
    }
    if (b === "whisper" && method === "POST") {
      const body = await readBody<{ model?: string }>(req);
      const job = createJob("whisper-install", "Installation de Whisper");
      installWhisper(body.model || "ggml-small.bin", (p, msg) =>
        updateJob(job.id, { progress: p, message: msg || "Installation…" })
      )
        .then(() => finishJob(job.id, { ok: true }, "Whisper installé"))
        .catch((e) => failJob(job.id, e instanceof Error ? e.message : String(e)));
      return json({ job: job.id });
    }
    if (b === "rnnoise" && method === "POST") {
      const job = createJob("rnnoise-install", "Installation du modèle RNNoise");
      installRnnoise((p, msg) => updateJob(job.id, { progress: p, message: msg || "Téléchargement…" }))
        .then(() => finishJob(job.id, { ok: true }, "RNNoise installé"))
        .catch((e) => failJob(job.id, e instanceof Error ? e.message : String(e)));
      return json({ job: job.id });
    }
    return badRequest("Route setup inconnue", 404);
  }

  return null;
}
