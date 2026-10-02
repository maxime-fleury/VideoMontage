import { newId } from "./util";

export type JobStatus = "running" | "done" | "error";

export type Job = {
  id: string;
  type: string;
  label: string;
  status: JobStatus;
  progress: number; // 0..1
  message: string;
  result?: unknown;
  error?: string;
  createdAt: number;
  finishedAt?: number;
  logs: string[];
};

const jobs = new Map<string, Job>();
const listeners = new Map<string, Set<(job: Job) => void>>();

export function createJob(type: string, label: string): Job {
  const job: Job = {
    id: newId("job"),
    type,
    label,
    status: "running",
    progress: 0,
    message: "Démarrage…",
    createdAt: Date.now(),
    logs: [],
  };
  jobs.set(job.id, job);
  return job;
}

export function getJob(id: string) {
  return jobs.get(id) ?? null;
}

export function listJobs() {
  return [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 20);
}

function emit(job: Job) {
  const subs = listeners.get(job.id);
  if (!subs) return;
  for (const fn of subs) {
    try {
      fn(job);
    } catch {}
  }
}

export function updateJob(
  id: string,
  patch: Partial<Pick<Job, "progress" | "message" | "status" | "result" | "error">> & { log?: string }
) {
  const job = jobs.get(id);
  if (!job) return;
  if (patch.log) {
    job.logs.push(patch.log.slice(0, 500));
    if (job.logs.length > 200) job.logs.shift();
  }
  if (patch.progress !== undefined) job.progress = Math.max(0, Math.min(1, patch.progress));
  if (patch.message !== undefined) job.message = patch.message;
  if (patch.status !== undefined) job.status = patch.status;
  if (patch.result !== undefined) job.result = patch.result;
  if (patch.error !== undefined) job.error = patch.error;
  if (job.status !== "running") job.finishedAt = Date.now();
  emit(job);
}

export function finishJob(id: string, result: unknown, message = "Terminé") {
  updateJob(id, { status: "done", progress: 1, result, message });
}

export function failJob(id: string, error: string) {
  updateJob(id, { status: "error", error, message: "Échec" });
}

export function subscribeJob(id: string, fn: (job: Job) => void) {
  let subs = listeners.get(id);
  if (!subs) {
    subs = new Set();
    listeners.set(id, subs);
  }
  subs.add(fn);
  return () => {
    subs!.delete(fn);
    if (subs!.size === 0) listeners.delete(id);
  };
}

/** Stream SSE pour suivre une tâche. */
export function jobEventStream(id: string): Response {
  const job = getJob(id);
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let interval: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (j: Job) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(j)}\n\n`));
        } catch {}
      };
      if (job) send(job);
      unsubscribe = subscribeJob(id, (j) => {
        send(j);
        if (j.status !== "running") {
          try {
            controller.close();
          } catch {}
        }
      });
      interval = setInterval(() => {
        const j = getJob(id);
        if (!j || j.status !== "running") return;
      }, 15000);
    },
    cancel() {
      unsubscribe?.();
      if (interval) clearInterval(interval);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

/** Nettoie les vieilles tâches. */
setInterval(() => {
  const cutoff = Date.now() - 1000 * 60 * 60 * 6;
  for (const [id, job] of jobs) {
    if (job.createdAt < cutoff) jobs.delete(id);
  }
}, 1000 * 60 * 10).unref?.();
