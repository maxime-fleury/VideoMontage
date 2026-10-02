import { clamp } from "./api.js";
import { evalExpr, fillTemplate } from "./expr.js";

/**
 * Géométrie d'une incrustation à un instant local donné.
 *
 * Le modèle de position est celui du rendu (fractions 0..1 du cadre) : les
 * gabarits de mouvement viennent du serveur (`motions.templates`), donc
 * l'aperçu et ffmpeg calculent exactement les mêmes nombres.
 *
 * Module sans DOM : testé directement par tests/front.test.ts.
 */
export function overlayGeometry(clip, local, motions) {
  const templates = motions?.templates?.[clip.motion?.preset] || { dx: "0", dy: "0", scale: "1" };
  const duration = Math.max(0.05, clip.duration);
  const values = {
    D: duration,
    A: clamp(clip.motion?.amount ?? 0.5, 0, 1),
    BW: clip.box.w,
    BH: clip.box.h,
    P: clamp(local / duration, 0, 1),
  };
  const evaluate = (template) => {
    try {
      return evalExpr(fillTemplate(template, values), { t: Math.max(0, local) });
    } catch {
      return 0;
    }
  };
  const dx = evaluate(templates.dx || "0");
  const dy = evaluate(templates.dy || "0");
  const scale = evaluate(templates.scale || "1") || 1;
  const w = clip.box.w * scale;
  const h = clip.box.h * scale;
  return {
    x: clip.box.x + clip.box.w / 2 - w / 2 + dx,
    y: clip.box.y + clip.box.h / 2 - h / 2 + dy,
    w,
    h,
    scale,
  };
}

/** Fondu d'entrée/sortie d'une incrustation à un instant local. */
export function overlayAlpha(clip, local) {
  const duration = Math.max(0.05, clip.duration);
  const base = clamp(clip.opacity ?? 1, 0, 1);
  const fadeIn = Math.max(0, Math.min(clip.fadeIn || 0, duration / 2));
  const fadeOut = Math.max(0, Math.min(clip.fadeOut || 0, duration / 2));
  let alpha = base;
  if (fadeIn > 0.02 && local < fadeIn) alpha *= clamp(local / fadeIn, 0, 1);
  if (fadeOut > 0.02 && local > duration - fadeOut) alpha *= clamp((duration - local) / fadeOut, 0, 1);
  return clamp(alpha, 0, 1);
}
