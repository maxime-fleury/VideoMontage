import { DATA_DIR, ensureDir, json } from "./lib/util";
import { FONTS_DIR, FONT_TTF_DIR, installRecommendedFonts } from "./lib/fonts";
import { serveProjectFile, serveStatic } from "./lib/http";
import { handleJobs } from "./routes/jobs";
import { handleSystem } from "./routes/system";
import { handleProjects } from "./routes/project";
import type { RouteCtx } from "./routes/types";

const NAME = "Montage Video";
const BASE_PORT = Number(process.env.MONTAGE_PORT || process.env.PORT) || 3000;
const MIN_PORT = BASE_PORT;
const MAX_PORT = BASE_PORT + 600;

/**
 * Point d'entrée : analyse l'URL puis délègue aux modules de routes.
 * Chaque module renvoie null quand la requête ne le concerne pas.
 */
async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const parts = url.pathname
    .split("/")
    .filter(Boolean)
    .map((p) => {
      try {
        return decodeURIComponent(p);
      } catch {
        return p;
      }
    });
  const ctx: RouteCtx = { req, parts, url, method: req.method.toUpperCase() };

  try {
    if (parts[0] === "api") {
      return (
        (await handleJobs(ctx)) ??
        (await handleSystem(ctx)) ??
        (await handleProjects(ctx)) ??
        json({ error: "Route API inconnue" }, 404)
      );
    }
    if (parts[0] === "fonts" && parts[1]) {
      const file = Bun.file(`${FONT_TTF_DIR}/${decodeURIComponent(parts[1]).split(/[\\/]/).pop()}`);
      if (!(await file.exists())) return new Response("Police introuvable", { status: 404 });
      return new Response(file, { headers: { "cache-control": "public, max-age=86400" } });
    }
    if (parts[0] === "media" && parts.length >= 3) {
      return await serveProjectFile(parts[1], parts.slice(2).join("/"));
    }
    if (parts.length === 0) return serveStatic("index.html");
    return serveStatic(parts.join("/"));
  } catch (e) {
    // une annulation utilisateur n'est pas une erreur serveur
    if (e instanceof Error && e.name === "RunCancelled") return json({ error: "Annulé" }, 409);
    console.error("Erreur serveur", e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
}

function findAvailablePort(start: number, end: number) {
  for (let port = start; port <= end; port++) {
    try {
      return Bun.serve({ port, fetch: handler, maxRequestBodySize: 1024 * 1024 * 1024, idleTimeout: 255 });
    } catch {
      console.log(`  port ${port} occupé — essai ${port + 1}…`);
    }
  }
  return null;
}

const server = findAvailablePort(MIN_PORT, MAX_PORT);
if (!server) {
  console.error(`Aucun port libre entre ${MIN_PORT} et ${MAX_PORT} — abandon.`);
  process.exit(1);
}
await ensureDir(DATA_DIR, `${DATA_DIR}/cache`, FONTS_DIR, FONT_TTF_DIR);
console.log(`🟤 ${NAME} prêt → http://localhost:${server.port}`);

// polices recommandées en tâche de fond (silencieux, non bloquant)
// (désactivable pour les tests : voir MONTAGE_SKIP_AUTOFONTS)
if (process.env.MONTAGE_SKIP_AUTOFONTS !== "1") installRecommendedFonts().catch(() => {});
