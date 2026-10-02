import fs from "node:fs/promises";
import path from "node:path";
import {
  badRequest,
  buildDir,
  clamp,
  ensureDir,
  json,
  mediaDir,
  newId,
  projectDir,
  sanitizeText,
  slug,
} from "../lib/util";
import {
  createProject,
  defaultEdits,
  ensureProjectDirs,
  getProject,
  listProjects,
  montageDuration,
  saveProject,
  type Project,
  type Source,
} from "../lib/store";
import { probe } from "../lib/ffmpeg";
import { defaultSubtitles } from "../lib/subtitles";
import { readBody } from "../lib/http";
import { recompile, serialize } from "../lib/projectview";
import { MAX_OVERLAY_LAYERS, normalizeOverlayLayers, normalizeTextOverlay } from "../lib/validate";
import { handleVoice } from "./voice";
import { handleIllustrations } from "./illustrations";
import { handleAuto } from "./auto";
import { handleMontage } from "./montage";
import type { ProjectRouteCtx, RouteCtx } from "./types";

/** Routes /api/projects — CRUD, import/export d'archive, upload de médias. */
export async function handleProjects(ctx: RouteCtx): Promise<Response | null> {
  const { req, parts, method } = ctx;
  const [, a, b, c] = parts;
  if (a !== "projects") return null;

  // liste et création
  if (!b && method === "GET") {
    const projects = await listProjects();
    return json({
      projects: projects.map((p) => ({
        id: p.id,
        name: p.name,
        updatedAt: p.updatedAt,
        duration: montageDuration(p),
        sources: p.sources.length,
        clips: p.videoTrack.length,
      })),
    });
  }

  if (!b && method === "POST") {
    const body = await readBody<{ name?: string }>(req);
    const project = await createProject(body.name || "Nouveau montage");
    return json({ project: serialize(project) });
  }

  // /api/projects/import  (restaure une archive .tar.gz exportée depuis l'app)
  if (b === "import" && method === "POST") return importArchive(req);

  if (!b) return badRequest("Projet manquant");

  const project = await getProject(b);
  if (!project) return badRequest("Projet introuvable", 404);
  const pid = project.id;
  const projectCtx: ProjectRouteCtx = { ...ctx, project, pid };

  // /api/projects/:id
  if (!c && method === "GET") return json({ project: serialize(project) });
  if (!c && method === "DELETE") {
    await fs.rm(projectDir(pid), { recursive: true, force: true });
    return json({ ok: true });
  }

  // /api/projects/:id/update  (état générique: nom, sorties, clips, pistes)
  if (c === "update" && method === "POST") return updateProject(projectCtx);

  // /api/projects/:id/archive  (sauvegarde complète: projet + médias + voix)
  if (c === "archive" && method === "GET") return archiveProject(projectCtx);

  // /api/projects/:id/upload  (multipart)
  if (c === "upload" && method === "POST") return uploadSource(projectCtx);

  return (
    (await handleVoice(projectCtx)) ??
    (await handleIllustrations(projectCtx)) ??
    (await handleAuto(projectCtx)) ??
    (await handleMontage(projectCtx)) ??
    badRequest("Route projet inconnue", 404)
  );
}

async function importArchive(req: Request): Promise<Response> {
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return badRequest("Archive manquante");
  const raw = new Uint8Array(await file.arrayBuffer());
  if (!raw.length) return badRequest("Archive vide");
  let data = raw;
  if (raw[0] === 0x1f && raw[1] === 0x8b) {
    try {
      data = new Uint8Array(Bun.gunzipSync(raw));
    } catch (e) {
      return badRequest(`Archive illisible : ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  let entries: Map<string, Blob>;
  try {
    entries = await new Bun.Archive(data).files();
  } catch (e) {
    return badRequest(`Archive illisible : ${e instanceof Error ? e.message : String(e)}`);
  }

  const projectFile = entries.get("project.json");
  if (!projectFile) return badRequest("Cette archive ne contient pas de projet");
  let imported: Project;
  try {
    imported = JSON.parse(await projectFile.text()) as Project;
  } catch {
    return badRequest("project.json illisible dans l'archive");
  }

  const id = newId("prj");
  await ensureProjectDirs(id);
  await ensureDir(mediaDir(id), buildDir(id));
  for (const [name, blob] of entries) {
    // on n'extrait que les dossiers connus, sans traversée de chemin
    const bits = name.split("/");
    if (bits.length !== 2) continue;
    const [folder, fileName] = bits;
    if (folder !== "media" && folder !== "build") continue;
    if (!fileName || fileName.includes("..")) continue;
    const target = folder === "media" ? mediaDir(id) : buildDir(id);
    await Bun.write(`${target}/${path.basename(fileName)}`, blob);
  }

  const project: Project = {
    ...imported,
    id,
    name: `${sanitizeText(imported.name || "Projet", "Projet")} (importé)`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    voice: { ...imported.voice, build: imported.voice?.build ? { ...imported.voice.build, builtAt: Date.now() } : undefined },
  };
  await saveProject(project);
  return json({ project: serialize(project) });
}

async function updateProject({ req, project }: ProjectRouteCtx): Promise<Response> {
  const body = await readBody<Partial<Project>>(req);
  if (body.name) project.name = String(body.name).slice(0, 120);
  if (body.output) project.output = { ...project.output, ...body.output };
  if (body.subtitles) project.subtitles = { ...project.subtitles, ...body.subtitles };
  if (Array.isArray(body.texts)) project.texts = body.texts.map(normalizeTextOverlay);
  if (body.overlayLayers !== undefined) {
    // la limite de calques est une contrainte du modèle : on la refuse côté serveur
    const layers = normalizeOverlayLayers(body.overlayLayers);
    if (!layers) {
      return badRequest(
        Array.isArray(body.overlayLayers) && body.overlayLayers.length > MAX_OVERLAY_LAYERS
          ? `Maximum ${MAX_OVERLAY_LAYERS} pistes de superposition`
          : "Calques invalides"
      );
    }
    project.overlayLayers = layers;
  }
  if (body.auto && typeof body.auto === "object") {
    project.auto = { ...(project.auto || { completed: [], updatedAt: Date.now() }), ...body.auto };
  }
  if (Array.isArray(body.videoTrack)) {
    const transitions = ["cut", "fade-black", "dissolve", "slide-left", "slide-right", "slide-up", "slide-down", "zoom-in"];
    project.videoTrack = body.videoTrack
      .map((clip) => ({
        ...clip,
        start: clamp(Number(clip.start) || 0, 0, 1e6),
        duration: Math.max(0.05, Number(clip.duration) || 1),
        offset: Math.max(0, Number(clip.offset) || 0),
        effect: {
          fadeIn: clamp(Number(clip.effect?.fadeIn) || 0, 0, 10),
          fadeOut: clamp(Number(clip.effect?.fadeOut) || 0, 0, 10),
          kenBurns: !!clip.effect?.kenBurns,
          zoomFrom: Number(clip.effect?.zoomFrom) || 1,
          zoomTo: Number(clip.effect?.zoomTo) || 1.1,
          transition: {
            type: transitions.includes(String(clip.effect?.transition?.type))
              ? (clip.effect?.transition?.type as any)
              : "fade-black",
            duration: clamp(Number(clip.effect?.transition?.duration) || 0, 0, 4),
          },
        },
      }))
      .filter((clip) => project.sources.some((s) => s.id === clip.sourceId));
  }
  if (body.subtitles) {
    const incoming = body.subtitles as any;
    const current = { ...defaultSubtitles(), ...(project.subtitles || {}) };
    project.subtitles = {
      ...current,
      ...incoming,
      enabled: !!incoming.enabled,
      fontSize: clamp(Number(incoming.fontSize ?? current.fontSize), 16, 160),
      outlineWidth: clamp(Number(incoming.outlineWidth ?? current.outlineWidth), 0, 12),
      maxWordsPerLine: clamp(Number(incoming.maxWordsPerLine ?? current.maxWordsPerLine), 1, 12),
      marginBottom: clamp(Number(incoming.marginBottom ?? current.marginBottom), 0, 400),
      position: ["bottom", "middle", "top"].includes(incoming.position) ? incoming.position : current.position,
      animation: ["none", "fade", "pop", "slide"].includes(incoming.animation) ? incoming.animation : current.animation,
    };
  }
  if (Array.isArray(body.audioTracks)) {
    project.audioTracks = body.audioTracks.map((track) => ({
      ...track,
      clips: (track.clips || [])
        .filter((clip) => project.sources.some((s) => s.id === clip.sourceId))
        .map((clip) => ({
          ...clip,
          start: clamp(Number(clip.start) || 0, 0, 1e6),
          duration: Math.max(0.05, Number(clip.duration) || 1),
          offset: Math.max(0, Number(clip.offset) || 0),
          gain: clamp(Number(clip.gain ?? 1), 0, 4),
          fadeIn: clamp(Number(clip.fadeIn) || 0, 0, 30),
          fadeOut: clamp(Number(clip.fadeOut) || 0, 0, 30),
        })),
    }));
  }
  if (body.transcript === null) {
    project.transcript = undefined;
  } else if (body.transcript !== undefined) {
    project.transcript = body.transcript;
  }
  if (body.voice) {
    project.voice = {
      ...project.voice,
      ...body.voice,
      edits: { ...project.voice.edits, ...(body.voice.edits || {}) },
    };
  }
  await saveProject(project);
  // l'état voix (coupes, silences, débruitage) impose de reconstruire la piste
  if (body.voice) {
    const warnings: string[] = [];
    await recompile(project, warnings);
    await saveProject(project);
    return json({ project: serialize(project), warnings });
  }
  return json({ project: serialize(project) });
}

async function archiveProject({ project, pid }: ProjectRouteCtx): Promise<Response> {
  const files: Record<string, Uint8Array | string> = {};
  files["project.json"] = await Bun.file(`${projectDir(pid)}/project.json`).text();
  for (const name of await fs.readdir(mediaDir(pid)).catch(() => [])) {
    const file = Bun.file(`${mediaDir(pid)}/${name}`);
    files[`media/${name}`] = new Uint8Array(await file.arrayBuffer());
  }
  for (const name of ["voice.mp3", "voice16k.wav"]) {
    const file = Bun.file(`${buildDir(pid)}/${name}`);
    if (await file.exists()) files[`build/${name}`] = new Uint8Array(await file.arrayBuffer());
  }
  const raw = await new Bun.Archive(files).bytes();
  const gz = Bun.gzipSync(raw);
  const archiveName = `${slug(project.name || "montage")}.tar.gz`;
  return new Response(gz, {
    headers: {
      "content-type": "application/gzip",
      "content-disposition": `attachment; filename="${archiveName}"`,
      "content-length": String(gz.length),
    },
  });
}

async function uploadSource({ req, project, pid }: ProjectRouteCtx): Promise<Response> {
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return badRequest("Fichier manquant");
  const role = String(form.get("role") || ""); // voice | clip | music
  const name = sanitizeText(String(form.get("name") || file.name || "media"), "média");
  await ensureProjectDirs(pid);
  await ensureDir(mediaDir(pid));
  const ext = (name.match(/\.[a-z0-9]+$/i)?.[0] || ".bin").toLowerCase();
  const fileName = `${newId("src")}-${slug(name.replace(/\.[a-z0-9]+$/i, ""))}${ext}`;
  const fullPath = `${mediaDir(pid)}/${fileName}`;
  await Bun.write(fullPath, file);

  let info;
  try {
    info = await probe(fullPath);
  } catch (e) {
    await fs.rm(fullPath, { force: true });
    return badRequest(`Fichier illisible : ${e instanceof Error ? e.message : String(e)}`);
  }
  const mime = (file.type || "").toLowerCase();
  const imageExt = /\.(jpe?g|png|webp|gif|bmp|avif|tiff?)$/i.test(name);
  const kind: Source["kind"] = mime.startsWith("image/") || imageExt ? "image" : info.hasVideo ? "video" : "audio";

  const source: Source = {
    id: newId("src"),
    kind,
    name,
    file: fileName,
    duration: info.duration,
    sampleRate: info.sampleRate,
    channels: info.channels,
    width: info.width,
    height: info.height,
    fps: info.fps,
    origin: role === "voice" ? "record" : "upload",
    createdAt: Date.now(),
  };
  project.sources.push(source);
  const warnings: string[] = [];
  if (role === "voice") {
    project.voice.sourceId = source.id;
    project.voice.edits = defaultEdits();
  }
  await saveProject(project);
  if (role === "voice") await recompile(project, warnings);
  return json({ project: serialize(project), source, warnings });
}
