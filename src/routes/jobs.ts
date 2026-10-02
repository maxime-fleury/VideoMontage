import { badRequest, json } from "../lib/util";
import { cancelJob, getJob, jobEventStream, listJobs, resumeJob } from "../lib/jobs";
import { readBody } from "../lib/http";
import type { RouteCtx } from "./types";

/** Routes /api/jobs — suivi SSE, reprise après point de contrôle, annulation. */
export async function handleJobs({ req, parts, method }: RouteCtx): Promise<Response | null> {
  const [, a, b, c] = parts;
  if (a !== "jobs") return null;

  if (!b) return json({ jobs: listJobs() });
  if (c === "events") return jobEventStream(b);
  if (c === "resume" && method === "POST") {
    const body = await readBody<{ data?: unknown; action?: string }>(req);
    const data = {
      ...(body.data && typeof body.data === "object" ? (body.data as Record<string, unknown>) : {}),
      action: body.action || "resume",
    };
    return resumeJob(b, data) ? json({ ok: true }) : badRequest("Aucune reprise en attente", 409);
  }
  if (c === "cancel" && method === "POST") {
    return cancelJob(b) ? json({ ok: true }) : badRequest("Tâche déjà terminée", 409);
  }
  const job = getJob(b);
  return job ? json(job) : badRequest("Tâche inconnue", 404);
}
