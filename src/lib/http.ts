import path from "node:path";
import { buildDir, mediaDir } from "./util";

const PUBLIC_DIR = "public";

export async function readBody<T = any>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    return {} as T;
  }
}

export async function serveStatic(rel: string) {
  const safe = rel.replace(/\.\./g, "").replace(/^\/+/, "");
  const filePath = path.join(PUBLIC_DIR, safe);
  const file = Bun.file(filePath);
  if (!(await file.exists())) return new Response("Introuvable", { status: 404 });
  return new Response(file);
}

export async function serveProjectFile(pid: string, file: string) {
  const safe = path.basename(file);
  const candidates = [`${buildDir(pid)}/${safe}`, `${mediaDir(pid)}/${safe}`];
  for (const c of candidates) {
    const f = Bun.file(c);
    if (await f.exists()) {
      const headers: Record<string, string> = {};
      if (safe.endsWith(".mp4")) headers["content-type"] = "video/mp4";
      return new Response(f, { headers });
    }
  }
  return new Response("Fichier introuvable", { status: 404 });
}
