import fs from "node:fs/promises";
import path from "node:path";
import { MODELS_DIR, WHISPER_DIR, buildDir, ensureDir, formatBytes, run, runSync } from "./util";
import type { Project, Transcript, TranscriptSegment, Word } from "./store";

export const WHISPER_MODELS = [
  { id: "ggml-base.bin", label: "Base — rapide", sizeMb: 142, url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin" },
  { id: "ggml-small.bin", label: "Small — recommandé", sizeMb: 466, url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin" },
  { id: "ggml-medium.bin", label: "Medium — précis", sizeMb: 1530, url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin" },
  { id: "ggml-large-v3-turbo.bin", label: "Large v3 turbo — max", sizeMb: 1620, url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin" },
];

const BIN_DIR = `${WHISPER_DIR}/bin`;

function platformAsset(): { url: string; archive: "zip" | "tar" } | null {
  const platform = process.platform;
  const arch = process.arch;
  const base = "https://github.com/ggml-org/whisper.cpp/releases/download/b5130";
  if (platform === "win32") {
    if (arch === "x64") return { url: `${base}/whisper-blas-bin-x64.zip`, archive: "zip" };
    return { url: `${base}/whisper-bin-win-cpu-arm64.zip`, archive: "zip" };
  }
  if (platform === "linux" && arch === "x64") return { url: `${base}/whisper-bin-ubuntu-x64.tar.gz`, archive: "tar" };
  if (platform === "linux" && arch === "arm64") return { url: `${base}/whisper-bin-ubuntu-arm64.tar.gz`, archive: "tar" };
  return null;
}

async function findBinaryIn(dir: string, depth = 0): Promise<string | null> {
  if (depth > 4) return null;
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files = entries.filter((e) => e.isFile()).map((e) => e.name);
    for (const preferred of [/^whisper-cli\.exe$/i, /^whisper-cli$/i, /^main\.exe$/i, /^main$/i]) {
      const hit = files.find((f) => preferred.test(f));
      if (hit) return path.join(dir, hit);
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const found = await findBinaryIn(path.join(dir, entry.name), depth + 1);
      if (found) return found;
    }
  } catch {}
  return null;
}

function findInPath(): string | null {
  const names = process.platform === "win32" ? ["whisper-cli.exe", "main.exe"] : ["whisper-cli", "main", "whisper-cpp"];
  for (const name of names) {
    const res = runSync([name, "--help"]);
    if (res.code === 0 || res.stdout.includes("usage") || res.stderr.includes("usage")) return name;
  }
  return null;
}

export async function whisperBinary(): Promise<string | null> {
  const local = await findBinaryIn(BIN_DIR);
  if (local) return local;
  return findInPath();
}

export async function whisperStatus() {
  const binary = await whisperBinary();
  const models = [];
  for (const m of WHISPER_MODELS) {
    const p = `${MODELS_DIR}/${m.id}`;
    const exists = await Bun.file(p).exists();
    const size = exists ? (await fs.stat(p)).size : 0;
    models.push({ ...m, installed: exists, installedSize: size, path: p });
  }
  let rnnoise: string | null = null;
  try {
    const files = await fs.readdir(MODELS_DIR);
    rnnoise = files.find((f) => f.endsWith(".rnnn")) || null;
  } catch {}
  return {
    binary: binary ? path.basename(binary) : null,
    binaryPath: binary,
    canInstall: !!platformAsset() || !!binary,
    platform: process.platform,
    models,
    rnnoise,
    ready: !!binary && models.some((m) => m.installed),
  };
}

async function download(url: string, dest: string, onProgress?: (p: number, msg?: string) => void) {
  await ensureDir(path.dirname(dest));
  const resp = await fetch(url, { redirect: "follow" });
  if (!resp.ok || !resp.body) throw new Error(`Téléchargement impossible (${resp.status}) : ${url}`);
  const total = Number(resp.headers.get("content-length") || 0);
  const writer = Bun.file(dest).writer();
  const reader = resp.body.getReader();
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    writer.write(value);
    received += value.length;
    if (total) onProgress?.(Math.min(0.99, received / total), `${formatBytes(received)} / ${formatBytes(total)}`);
    else onProgress?.(0.5, formatBytes(received));
  }
  await writer.end();
  return dest;
}

async function extractArchive(archive: string, dest: string) {
  await ensureDir(dest);
  const attempts: string[][] = [];
  if (archive.endsWith(".zip")) {
    if (process.platform === "win32") {
      attempts.push(["C:/Windows/System32/tar.exe", "-xf", archive, "-C", dest]);
      attempts.push([
        "powershell",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Expand-Archive -Force -LiteralPath '${archive}' -DestinationPath '${dest}'`,
      ]);
    }
    attempts.push(["unzip", "-o", "-q", archive, "-d", dest]);
    attempts.push(["tar", "-xf", archive, "-C", dest]);
  } else {
    attempts.push(["tar", "-xzf", archive, "-C", dest]);
  }
  for (const cmd of attempts) {
    try {
      const res = await run(cmd, { timeoutMs: 120000 });
      if (res.code === 0) return true;
    } catch {}
  }
  throw new Error("Extraction de l'archive impossible (tar/unzip/Expand-Archive ont échoué)");
}

export async function installWhisper(
  modelId: string,
  onProgress: (p: number, msg?: string) => void
): Promise<void> {
  await ensureDir(BIN_DIR);
  let binary = await whisperBinary();
  if (!binary) {
    const asset = platformAsset();
    if (!asset) throw new Error("Pas de binaire whisper.cpp précompilé pour cette plateforme — installe whisper-cpp manuellement");
    const archive = `${WHISPER_DIR}/${path.basename(asset.url)}`;
    onProgress(0.02, "Téléchargement de whisper.cpp…");
    await download(asset.url, archive, (p, msg) => onProgress(0.02 + p * 0.4, `whisper.cpp : ${msg}`));
    onProgress(0.45, "Extraction…");
    await extractArchive(archive, BIN_DIR);
    binary = await whisperBinary();
    if (!binary) throw new Error("Binaire whisper-cli introuvable après extraction");
    await fs.rm(archive, { force: true });
  }
  const model = WHISPER_MODELS.find((m) => m.id === modelId) || WHISPER_MODELS[1];
  const modelPath = `${MODELS_DIR}/${model.id}`;
  if (!(await Bun.file(modelPath).exists())) {
    onProgress(0.5, `Téléchargement du modèle ${model.label}…`);
    const tmp = `${modelPath}.part`;
    await download(model.url, tmp, (p, msg) => onProgress(0.5 + p * 0.48, `Modèle : ${msg}`));
    await fs.rename(tmp, modelPath);
  }
  onProgress(1, "Whisper prêt");
}

export async function installRnnoise(onProgress: (p: number, msg?: string) => void) {
  const dest = `${MODELS_DIR}/mp.rnnn`;
  if (await Bun.file(dest).exists()) {
    onProgress(1, "Modèle RNNoise déjà installé");
    return;
  }
  const urls = [
    "https://raw.githubusercontent.com/richardpl/arnndn-models/master/mp.rnnn",
    "https://github.com/richardpl/arnndn-models/raw/master/mp.rnnn",
  ];
  let lastErr: unknown = null;
  for (const url of urls) {
    try {
      await download(url, dest, onProgress);
      const size = (await fs.stat(dest)).size;
      if (size < 10000) throw new Error("fichier trop petit");
      onProgress(1, "Modèle RNNoise installé");
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`Téléchargement RNNoise impossible : ${String(lastErr)}`);
}

let helpCache: string | null = null;
async function whisperHelp(binary: string) {
  if (helpCache !== null) return helpCache;
  const res = await run([binary, "--help"], { timeoutMs: 20000 });
  helpCache = `${res.stdout}\n${res.stderr}`;
  return helpCache;
}

type RawToken = { text: string; offsets: { from: number; to: number }; p?: number };

function cleanWord(raw: string) {
  return raw.replace(/[\u00a0\u200b\ufeff\u2009\u202f]/g, " ").trim();
}

function tokensToWords(tokens: RawToken[]): Word[] {
  const words: Word[] = [];
  let current: Word | null = null;
  const push = () => {
    if (!current) return;
    const text = cleanWord(current.w);
    // on garde uniquement ce qui contient une lettre ou un chiffre
    if (text && /[\p{L}\p{N}]/u.test(text)) {
      words.push({ w: text, s: current.s / 1000, e: current.e / 1000 });
    }
    current = null;
  };
  for (const token of tokens) {
    const text = token.text ?? "";
    if (!text || text.startsWith("[") || text.startsWith("<|")) continue;
    const time = { s: token.offsets?.from ?? 0, e: token.offsets?.to ?? 0 };
    const startsWord = /\s/.test(text[0]) || current === null;
    if (startsWord) {
      push();
      current = { w: text, s: time.s, e: time.e };
    } else if (current) {
      current.w += text;
      current.e = Math.max(current.e, time.e);
    } else {
      current = { w: text, s: time.s, e: time.e };
    }
  }
  push();
  return words;
}

/** Transcrit la piste voix compilée (wav 16k mono). */
export async function transcribe(
  project: Project,
  opts: { model?: string; language?: string },
  onProgress: (p: number, msg?: string) => void
): Promise<Transcript> {
  const binary = await whisperBinary();
  if (!binary) throw new Error("Whisper n'est pas installé — clique sur « Installer Whisper »");
  const build = project.voice.build;
  if (!build) throw new Error("Compile d'abord la piste voix");
  const wav = `${buildDir(project.id)}/${build.wavFile}`;
  if (!(await Bun.file(wav).exists())) throw new Error("Fichier voix introuvable — recompile la piste voix");

  const modelPath = `${MODELS_DIR}/${opts.model || "ggml-small.bin"}`;
  if (!(await Bun.file(modelPath).exists())) throw new Error("Modèle Whisper introuvable — installe-le dans les paramètres");

  const outPrefix = `${buildDir(project.id)}/transcript`;
  const help = await whisperHelp(binary);
  const args: string[] = ["-m", modelPath, "-f", wav, "-l", opts.language || "fr"];
  if (help.includes("--output-json-full") || help.includes("-ojf")) {
    args.push("-ojf");
  } else if (help.includes("--output-json") || help.includes("-oj")) {
    args.push("-oj");
  } else {
    throw new Error("Ce binaire whisper ne gère pas la sortie JSON (mise à jour nécessaire)");
  }
  args.push("-of", outPrefix);
  if (help.includes("--print-progress") || help.includes("-pp")) args.push("-pp");
  onProgress(0.03, "Chargement du modèle…");

  const res = await run([binary, ...args], {
    timeoutMs: 1000 * 60 * 60,
    onStderr: (chunk) => {
      for (const line of chunk.split(/\r?\n/)) {
        const m = line.match(/progress\s*=\s*(\d+)\s*%/);
        if (m) {
          const p = Number(m[1]) / 100;
          onProgress(0.05 + p * 0.9, `Transcription ${m[1]}%`);
        }
      }
    },
  });
  if (res.code !== 0) throw new Error(`whisper a échoué : ${(res.stderr || res.stdout).slice(-600)}`);

  const jsonPath = `${outPrefix}.json`;
  const raw = await Bun.file(jsonPath).json();
  const entries: any[] = raw.transcription || [];
  const segments: TranscriptSegment[] = entries
    .map((entry, i) => {
      const words = tokensToWords(entry.tokens || []);
      const start = (entry.offsets?.from ?? (words[0]?.s ?? 0) * 1000) / 1000;
      const end = (entry.offsets?.to ?? (words[words.length - 1]?.e ?? 0) * 1000) / 1000;
      return {
        id: `seg_${i}`,
        start,
        end,
        text: (entry.text || "").trim(),
        words,
      };
    })
    .filter((s) => s.text.length > 0 || s.words.length > 0);

  return {
    language: raw?.result?.language || opts.language || "fr",
    model: opts.model || "ggml-small.bin",
    segments,
    builtAt: Date.now(),
    hash: build.hash,
  };
}
