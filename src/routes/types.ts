import type { Project } from "../lib/store";

/** Contexte d'une requête API découpée (chemins non décodés par le routeur). */
export type RouteCtx = {
  req: Request;
  /** segments du chemin, préfixe « api » inclus */
  parts: string[];
  url: URL;
  method: string;
};

/** Contexte des routes qui visent un projet déjà chargé. */
export type ProjectRouteCtx = RouteCtx & { project: Project; pid: string };

/** Renvoie null quand la route n'est pas gérée par le module. */
export type ApiHandler = (ctx: RouteCtx) => Promise<Response | null>;
export type ProjectHandler = (ctx: ProjectRouteCtx) => Promise<Response | null>;
