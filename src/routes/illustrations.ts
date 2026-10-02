import { badRequest, clamp, json, newId, sanitizeText } from "../lib/util";
import { defaultEffect, saveProject, type VideoClip } from "../lib/store";
import { downloadImage, searchImages } from "../lib/images";
import { editImage } from "../lib/imageEdit";
import { buildAutoSlots } from "../lib/keywords";
import { readBody } from "../lib/http";
import { serialize } from "../lib/projectview";
import type { ProjectRouteCtx } from "./types";

/** Recherche et ajout d'illustrations, retouche d'image, créneaux de mots-clés. */
export async function handleIllustrations(ctx: ProjectRouteCtx): Promise<Response | null> {
  const { req, parts, url, method, project } = ctx;
  const [, , , c] = parts;

  // --- recherche d'illustrations ------------------------------------------
  if (c === "search" && method === "POST") {
    const body = await readBody<{ query?: string; provider?: string; count?: number }>(req);
    const query = (body.query || "").trim();
    if (!query) return badRequest("Requête vide");
    const { results, errors } = await searchImages(query, { provider: body.provider, count: body.count });
    return json({ query, results, errors });
  }

  if (c === "add-image" && method === "POST") {
    const body = await readBody<{
      url?: string;
      fallbackUrl?: string;
      referer?: string;
      keyword?: string;
      provider?: string;
      start?: number;
      duration?: number;
    }>(req);
    if (!body.url) return badRequest("URL manquante");
    const keyword = sanitizeText(String(body.keyword || ""));
    const source = await downloadImage(project, {
      url: body.url,
      fallbackUrl: body.fallbackUrl,
      referer: body.referer,
      keyword,
      provider: body.provider,
    });
    project.sources.push(source);
    const clip: VideoClip = {
      id: newId("clip"),
      sourceId: source.id,
      keyword,
      start: Math.max(0, Number(body.start) || 0),
      duration: clamp(Number(body.duration) || 3, 0.2, 600),
      offset: 0,
      effect: defaultEffect(),
      createdAt: Date.now(),
    };
    project.videoTrack.push(clip);
    project.videoTrack.sort((x, y) => x.start - y.start);
    await saveProject(project);
    return json({ project: serialize(project), source, clip });
  }

  // --- retouche d'image --------------------------------------------------
  if (c === "edit-image" && method === "POST") {
    const body = await readBody<{ sourceId?: string; keyword?: string; ops?: Record<string, any> }>(req);
    const source = project.sources.find((s) => s.id === body.sourceId);
    if (!source || source.kind !== "image") return badRequest("Image introuvable");
    try {
      const edited = await editImage(project, source, body.ops || {}, sanitizeText(String(body.keyword || source.meta?.keyword || "")));
      project.sources.push(edited);
      await saveProject(project);
      return json({ project: serialize(project), source: edited });
    } catch (e) {
      return badRequest(e instanceof Error ? e.message : String(e));
    }
  }

  if (c === "keywords" && method === "GET") {
    const minDuration = clamp(Number(url.searchParams.get("minDuration") || 3.2), 1.5, 20);
    const slots = buildAutoSlots(project, minDuration).map((slot, index) => ({
      index,
      start: Number(slot.start.toFixed(2)),
      end: Number(slot.end.toFixed(2)),
      keyword: slot.top,
      alternatives: slot.keywords,
      scores: slot.scores,
    }));
    return json({ slots, hasTranscript: !!project.transcript });
  }

  return null;
}
