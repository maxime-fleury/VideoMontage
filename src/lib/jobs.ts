import { RunCancelled, newId, setActiveSignal } from "./util";

export type JobStatus = "running" | "waiting" | "done" | "error" | "cancelled";

/**
 * Point de contrôle : la tâche s'arrête (« waiting ») et attend une décision de
 * l'utilisateur via POST /api/jobs/:id/resume. Le process serveur n'est jamais
 * bloqué : on rend une promesse résolue à la reprise.
 */
export type JobCheckpoint = {
  id: string;
  label: string;
  /** message d'accompagnement affiché dans l'interface */
  message?: string;
  /** données à valider (statistiques, liste de mots-clés, récapitulatif…) */
  payload?: unknown;
  /** actions proposées : « resume » (continuer) / « adjust » (ajuster) / « cancel » */
  actions?: string[];
};

export type Job = {
  id: string;
  type: string;
  label: string;
  status: JobStatus;
  progress: number; // 0..1
  message: string;
  result?: unknown;
  error?: string;
  checkpoint?: JobCheckpoint | null;
  createdAt: number;
  finishedAt?: number;
  logs: string[];
};

const jobs = new Map<string, Job>();
const listeners = new Map<string, Set<(job: Job) => void>>();
/** Un contrôleur d'annulation par tâche : le signal tue les processus lancés. */
const controllers = new Map<string, AbortController>();

/** Tâches qui tuent leurs processus quand on les annule (voir setActiveSignal). */
const CANCELLABLE = new Set(["export", "auto-full", "auto-montage", "transcribe", "whisper-install", "rnnoise-install", "fonts"]);

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
  if (CANCELLABLE.has(type)) controllers.set(job.id, new AbortController());
  return job;
}

/** Signal d'annulation d'une tâche (jamais null : créé à la demande). */
export function jobSignal(id: string): AbortSignal {
  let controller = controllers.get(id);
  if (!controller) {
    controller = new AbortController();
    controllers.set(id, controller);
  }
  return controller.signal;
}

export function isCancelled(id: string) {
  if (jobs.get(id)?.status === "cancelled") return true;
  return controllers.get(id)?.signal.aborted === true;
}

/**
 * Annule une tâche : tue le processus en cours (ffmpeg, whisper…), réveille un
 * éventuel point de contrôle et marque la tâche « cancelled ».
 */
export function cancelJob(id: string): boolean {
  const job = jobs.get(id);
  if (!job || job.status === "done" || job.status === "error" || job.status === "cancelled") return false;
  controllers.get(id)?.abort();
  const waiter = waiters.get(id);
  if (waiter) {
    waiters.delete(id);
    waiter({ cancelled: true, action: "cancel" });
  }
  job.checkpoint = null;
  updateJob(id, { status: "cancelled", message: "Annulé", result: undefined, error: "Annulé" });
  controllers.delete(id);
  return true;
}

// --- un seul travail lourd à la fois ---------------------------------------

/** Tâche qui détient la place de travail lourd (une seule à la fois). */
let heavyOwner: string | null = null;
type HeavyWaiter = { id: string; granted: boolean; resolve: () => void; reject: (error: unknown) => void };
const heavyWaiters: HeavyWaiter[] = [];

/** Nombre de tâches en attente d'une place (diagnostic). */
export function heavyQueueSize() {
  return heavyWaiters.length + (heavyOwner ? 1 : 0);
}

/**
 * Exécute un travail lourd (rendu, transcription, montage auto) en s'assurant
 * qu'un seul tourne à la fois : les autres attendent leur tour et restent
 * annulables. Le signal du travail lourd est armé pour tuer les processus.
 *
 * Réentrant : une tâche qui détient déjà la place peut redécouper son travail en
 * plusieurs appels (c'est le cas du montage complet) sans se bloquer elle-même.
 */
export async function runHeavyJob<T>(
  id: string,
  task: () => Promise<T>,
  waitingMessage = "Un autre rendu est en cours"
): Promise<T> {
  const signal = jobSignal(id);
  if (signal.aborted) throw new RunCancelled();
  if (heavyOwner === id) return task();

  if (heavyOwner) {
    updateJob(id, { message: `${waitingMessage} — en attente…` });
    await new Promise<void>((resolve, reject) => {
      const waiter: HeavyWaiter = { id, granted: false, resolve, reject };
      heavyWaiters.push(waiter);
      const onAbort = () => {
        if (waiter.granted) return;
        const index = heavyWaiters.indexOf(waiter);
        if (index >= 0) heavyWaiters.splice(index, 1);
        reject(new RunCancelled());
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  } else {
    heavyOwner = id;
  }

  if (signal.aborted) {
    // la place vient d'être accordée mais la tâche a été annulée entre-temps
    releaseHeavy(id);
    throw new RunCancelled();
  }
  setActiveSignal(signal);
  try {
    return await task();
  } finally {
    setActiveSignal(null);
    releaseHeavy(id);
  }
}

/** Libère la place détenue par `id` et la transmet au suivant s'il y en a un. */
function releaseHeavy(id: string) {
  if (heavyOwner !== id) return;
  heavyOwner = null;
  const next = heavyWaiters.shift();
  if (!next) return;
  next.granted = true;
  heavyOwner = next.id;
  next.resolve();
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
  patch: Partial<Pick<Job, "progress" | "message" | "status" | "result" | "error" | "checkpoint">> & { log?: string }
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
  if (patch.checkpoint !== undefined) job.checkpoint = patch.checkpoint;
  // « waiting » n'est pas une fin : la tâche reprendra au clic sur Continuer.
  if (job.status !== "running" && job.status !== "waiting") {
    job.finishedAt = Date.now();
    controllers.delete(id);
  }
  emit(job);
}

const waiters = new Map<string, (data: unknown) => void>();

/** Met la tâche en pause sur un point de contrôle et rend la main. */
export function setCheckpoint(id: string, checkpoint: JobCheckpoint, progress?: number) {
  updateJob(id, { status: "waiting", checkpoint, progress, message: checkpoint.message || checkpoint.label });
  return waitForResume(id);
}

/** Promesse résolue quand l'utilisateur reprend la tâche (données de validation incluses). */
export function waitForResume(id: string): Promise<unknown> {
  return new Promise((resolve) => {
    waiters.set(id, resolve);
  });
}

/** Reprend une tâche en attente. Renvoie false si elle n'attend rien. */
export function resumeJob(id: string, data?: unknown): boolean {
  const job = jobs.get(id);
  const waiter = waiters.get(id);
  if (!job || !waiter) return false;
  waiters.delete(id);
  job.checkpoint = null;
  job.status = "running";
  job.message = "Reprise…";
  emit(job);
  waiter(data ?? {});
  return true;
}

export function finishJob(id: string, result: unknown, message = "Terminé") {
  updateJob(id, { status: "done", progress: 1, result, checkpoint: null, message });
}

export function failJob(id: string, error: string) {
  // une tâche annulée le reste : l'erreur du processus tué ne doit pas l'écraser
  if (jobs.get(id)?.status === "cancelled") return;
  updateJob(id, { status: "error", error, checkpoint: null, message: "Échec" });
  // Une tâche qui échouait alors qu'elle attendait une décision ne doit pas rester pendue.
  const waiter = waiters.get(id);
  if (waiter) {
    waiters.delete(id);
    waiter({ cancelled: true });
  }
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
        // « waiting » garde le flux ouvert : la tâche reprendra sur un clic.
        if (j.status !== "running" && j.status !== "waiting") {
          try {
            controller.close();
          } catch {}
        }
      });
      // Battement de cœur : sans trafic, Bun coupe la connexion inactive
      // (idleTimeout 255 s) et le navigateur bascule sur du polling.
      interval = setInterval(() => {
        const j = getJob(id);
        if (!j || (j.status !== "running" && j.status !== "waiting")) return;
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {}
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
    // Une tâche en attente d'une décision n'est jamais balayée.
    if (job.status === "waiting") continue;
    if (job.createdAt < cutoff) jobs.delete(id);
  }
}, 1000 * 60 * 10).unref?.();
