import fs from "node:fs/promises";

// surchargeables pour les tests (dossier de données isolé) : voir tests/api.test.ts
export const DATA_DIR = process.env.MONTAGE_DATA_DIR || "data";
export const PROJECTS_DIR = `${DATA_DIR}/projects`;
export const MODELS_DIR = `${DATA_DIR}/models`;
export const TOOLS_DIR = `${DATA_DIR}/tools`;
export const WHISPER_DIR = `${TOOLS_DIR}/whisper`;

export const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
export const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";

export function newId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function projectDir(pid: string) {
  return `${PROJECTS_DIR}/${pid}`;
}
export function mediaDir(pid: string) {
  return `${projectDir(pid)}/media`;
}
export function buildDir(pid: string) {
  return `${projectDir(pid)}/build`;
}

export async function ensureDir(...dirs: string[]) {
  for (const d of dirs) await fs.mkdir(d, { recursive: true });
}

export function json(data: unknown, status = 200) {
  // Les réponses de l'API sont dynamiques : sans cet en-tête, le navigateur peut
  // servir un projet périmé depuis son cache après une modification.
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}

export function badRequest(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}

export function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v));
}

/**
 * Nettoie un texte venu du client: caractères de remplacement (U+FFFD) issus
 * d'un encodage cassé, espaces insécables, caractères de contrôle.
 */
export function sanitizeText(input: string, fallback = "") {
  const cleaned = String(input ?? "")
    .replace(/[\uFFFD\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/[\u00a0\u2009\u202f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || fallback;
}

export function slug(name: string) {
  return sanitizeText(name, "fichier")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "fichier";
}

export type RunOptions = {
  cwd?: string;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  timeoutMs?: number;
  env?: Record<string, string>;
  /** Annulation fine ; par défaut le signal du travail lourd en cours (voir setActiveSignal). */
  signal?: AbortSignal;
};

export type RunResult = { code: number; stdout: string; stderr: string; killed: boolean; aborted: boolean };

/** Erreur levée quand l'utilisateur annule une tâche en cours. */
export class RunCancelled extends Error {
  constructor(message = "Opération annulée") {
    super(message);
    this.name = "RunCancelled";
  }
}

/**
 * Signal du travail lourd en cours (rendu, transcription, montage auto). Tant
 * qu'il est armé, chaque commande lancée est tuée à l'annulation — sans avoir à
 * faire descendre le signal dans toutes les signatures.
 */
let activeSignal: AbortSignal | null = null;

export function setActiveSignal(signal: AbortSignal | null) {
  activeSignal = signal;
}

/** Lance une commande, stream stdout/stderr, gère le timeout et l'annulation. */
export async function run(cmd: string[], opts: RunOptions = {}): Promise<RunResult> {
  const signal = opts.signal ?? activeSignal ?? undefined;
  if (signal?.aborted) throw new RunCancelled();
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...(opts.env || {}) },
  });
  const dec = new TextDecoder();
  let stdout = "";
  let stderr = "";
  let killed = false;
  let aborted = false;

  const onAbort = () => {
    aborted = true;
    killed = true;
    try {
      proc.kill("SIGKILL");
    } catch {}
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  const timer = opts.timeoutMs
    ? setTimeout(() => {
        killed = true;
        try {
          proc.kill();
        } catch {}
      }, opts.timeoutMs)
    : null;

  const pump = async (stream: ReadableStream<Uint8Array>, which: "out" | "err") => {
    for await (const chunk of stream) {
      const text = dec.decode(chunk, { stream: true });
      if (which === "out") {
        stdout += text;
        opts.onStdout?.(text);
      } else {
        stderr += text;
        opts.onStderr?.(text);
      }
    }
  };

  await Promise.all([pump(proc.stdout as any, "out"), pump(proc.stderr as any, "err")]);
  const code = await proc.exited;
  if (timer) clearTimeout(timer);
  signal?.removeEventListener("abort", onAbort);
  if (aborted || signal?.aborted) throw new RunCancelled();
  return { code, stdout, stderr, killed, aborted: false };
}

/** Commande courte, résultat synchrone (usage: probe, vérifications). */
export function runSync(cmd: string[]): RunResult {
  try {
    const proc = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
    return {
      code: proc.exitCode ?? -1,
      stdout: proc.stdout?.toString() ?? "",
      stderr: proc.stderr?.toString() ?? "",
      killed: false,
      aborted: false,
    };
  } catch (e) {
    return { code: -1, stdout: "", stderr: e instanceof Error ? e.message : String(e), killed: false, aborted: false };
  }
}

export function commandExists(cmd: string) {
  const r = runSync([cmd, "-version"]);
  return r.code === 0;
}

/**
 * Lit un JSON, avec repli sur la copie de secours `.bak` si le fichier principal
 * est illisible (écriture interrompue, disque plein, coupure de courant).
 */
export async function readJson<T>(path: string): Promise<T | null> {
  try {
    return (await Bun.file(path).json()) as T;
  } catch (error) {
    const exists = await Bun.file(path).exists();
    if (!exists && !(error instanceof SyntaxError)) return null;
    try {
      const backup = (await Bun.file(`${path}.bak`).json()) as T;
      console.warn(`⚠️  ${path} illisible — relecture depuis ${path}.bak`);
      return backup;
    } catch {
      console.error(`❌ ${path} illisible et aucune sauvegarde exploitable`);
      return null;
    }
  }
}

/**
 * Écriture atomique : on écrit dans un fichier temporaire puis on renomme, ce qui
 * évite tout fichier tronqué si le processus s'arrête en cours d'écriture. L'état
 * précédent est conservé en `.bak` pour pouvoir revenir en arrière.
 */
export async function writeJson(path: string, data: unknown) {
  await ensureDir(path.slice(0, path.lastIndexOf("/")));
  const json = JSON.stringify(data, null, 2);
  const tmp = `${path}.tmp`;
  await Bun.write(tmp, json);
  try {
    const current = Bun.file(path);
    if (await current.exists()) await Bun.write(`${path}.bak`, await current.arrayBuffer());
  } catch {
    // une sauvegarde de secours ratée ne doit pas empêcher l'enregistrement
  }
  await fs.rename(tmp, path);
}

export function formatBytes(n: number) {
  if (n > 1e9) return `${(n / 1e9).toFixed(2)} Go`;
  if (n > 1e6) return `${(n / 1e6).toFixed(1)} Mo`;
  if (n > 1e3) return `${(n / 1e3).toFixed(0)} Ko`;
  return `${n} o`;
}

export function parseTimecode(s: string): number {
  const m = s.match(/(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}
