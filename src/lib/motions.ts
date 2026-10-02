import type { Box, Motion, MotionPresetId, OverlayClip } from "./store";

/**
 * Placements et mouvements prédéfinis des incrustations.
 *
 * Chaque mouvement est décrit **une seule fois** par trois gabarits d'expression :
 *   dx    décalage horizontal, en fraction de la largeur de sortie
 *   dy    décalage vertical, en fraction de la hauteur de sortie
 *   scale facteur d'échelle appliqué autour du centre du cadre
 *
 * Ces chaînes partent telles quelles dans le filtre `overlay` de ffmpeg (le temps
 * local du clip est la variable `t`) et sont évaluées à l'identique par l'aperçu
 * via public/js/expr.js. Une seule vérité, donc aucun écart preview ↔ rendu.
 *
 * Variables des gabarits : `P` progression 0..1, `A` intensité 0..1, `BW`/`BH`
 * taille du cadre en fractions, `t` temps local du clip (fourni par ffmpeg).
 */
export type MotionPreset = {
  id: MotionPresetId;
  label: string;
  icon: string;
  hint: string;
  /** le curseur d'intensité a-t-il un effet ? */
  amount: boolean;
};

export const MOTIONS: MotionPreset[] = [
  { id: "none", label: "Aucun", icon: "⏹", hint: "Incrustation fixe", amount: false },
  { id: "pip-static", label: "PiP fixe", icon: "📺", hint: "Petite fenêtre immobile", amount: false },
  { id: "pip-corner", label: "PiP entrée", icon: "🎬", hint: "Glisse depuis le bord et grossit légèrement", amount: false },
  { id: "drift-left", label: "Dérive ←", icon: "⬅️", hint: "Traverse lentement vers la gauche", amount: true },
  { id: "drift-right", label: "Dérive →", icon: "➡️", hint: "Traverse lentement vers la droite", amount: true },
  { id: "drift-up", label: "Dérive ↑", icon: "⬆️", hint: "Monte lentement", amount: true },
  { id: "drift-down", label: "Dérive ↓", icon: "⬇️", hint: "Descend lentement", amount: true },
  { id: "zoom-in", label: "Zoom avant", icon: "🔍", hint: "Ken Burns sur l'incrustation", amount: true },
  { id: "zoom-out", label: "Zoom arrière", icon: "🔎", hint: "Part rapproché, recule", amount: true },
  { id: "pop", label: "Pop", icon: "✨", hint: "Apparition en grossissant", amount: false },
  { id: "slide-in-left", label: "Entre ←", icon: "🫲", hint: "Arrive depuis la gauche", amount: false },
  { id: "slide-in-right", label: "Entre →", icon: "🫱", hint: "Arrive depuis la droite", amount: false },
  { id: "slide-in-top", label: "Entre ↑", icon: "👆", hint: "Tombe depuis le haut", amount: false },
  { id: "slide-in-bottom", label: "Entre ↓", icon: "👇", hint: "Monte depuis le bas", amount: false },
];

const ENTER = (d: number) => `min(1,max(0,t/${d}))`;

export const MOTION_TEMPLATES: Record<MotionPresetId, { dx: string; dy: string; scale: string }> = {
  none: { dx: "0", dy: "0", scale: "1" },
  "pip-static": { dx: "0", dy: "0", scale: "1" },
  "pip-corner": {
    dx: `0.05*(1-${ENTER(0.4)})`,
    dy: `0.03*(1-${ENTER(0.4)})`,
    scale: `1+0.05*(1-${ENTER(0.35)})`,
  },
  "drift-left": { dx: "0.12*A*(1-2*P)", dy: "0", scale: "1" },
  "drift-right": { dx: "-0.12*A*(1-2*P)", dy: "0", scale: "1" },
  "drift-up": { dx: "0", dy: "0.09*A*(1-2*P)", scale: "1" },
  "drift-down": { dx: "0", dy: "-0.09*A*(1-2*P)", scale: "1" },
  "zoom-in": { dx: "0", dy: "0", scale: "1+0.25*A*P" },
  "zoom-out": { dx: "0", dy: "0", scale: "1+0.25*A*(1-P)" },
  pop: { dx: "0", dy: "0", scale: `1-0.3*(1-${ENTER(0.35)})` },
  "slide-in-left": { dx: `-(BW+0.05)*(1-${ENTER(0.45)})`, dy: "0", scale: "1" },
  "slide-in-right": { dx: `(BW+0.05)*(1-${ENTER(0.45)})`, dy: "0", scale: "1" },
  "slide-in-top": { dx: "0", dy: `-(BH+0.05)*(1-${ENTER(0.45)})`, scale: "1" },
  "slide-in-bottom": { dx: "0", dy: `(BH+0.05)*(1-${ENTER(0.45)})`, scale: "1" },
};

/** Agencements prêts à l'emploi (position + taille + mouvement conseillé). */
export type Placement = { id: string; label: string; icon: string; box: Box; motion: MotionPresetId };

export const PLACEMENTS: Placement[] = [
  { id: "fullscreen", label: "Plein cadre", icon: "🖥️", box: { x: 0, y: 0, w: 1, h: 1 }, motion: "pop" },
  { id: "half-left", label: "Moitié gauche", icon: "◧", box: { x: 0, y: 0, w: 0.5, h: 1 }, motion: "slide-in-left" },
  { id: "half-right", label: "Moitié droite", icon: "◨", box: { x: 0.5, y: 0, w: 0.5, h: 1 }, motion: "slide-in-right" },
  { id: "pip-br", label: "PiP bas-droite", icon: "📺", box: { x: 0.62, y: 0.6, w: 0.34, h: 0.34 }, motion: "pip-corner" },
  { id: "pip-tr", label: "PiP haut-droite", icon: "📺", box: { x: 0.62, y: 0.06, w: 0.34, h: 0.34 }, motion: "pip-corner" },
  { id: "pip-bl", label: "PiP bas-gauche", icon: "📺", box: { x: 0.04, y: 0.6, w: 0.34, h: 0.34 }, motion: "pip-corner" },
  { id: "pip-tl", label: "PiP haut-gauche", icon: "📺", box: { x: 0.04, y: 0.06, w: 0.34, h: 0.34 }, motion: "pip-corner" },
  { id: "band-bottom", label: "Bandeau bas", icon: "▭", box: { x: 0.08, y: 0.68, w: 0.84, h: 0.26 }, motion: "slide-in-bottom" },
  { id: "band-top", label: "Bandeau haut", icon: "▭", box: { x: 0.08, y: 0.06, w: 0.84, h: 0.26 }, motion: "slide-in-top" },
  { id: "center-card", label: "Vignette centre", icon: "🔲", box: { x: 0.28, y: 0.3, w: 0.44, h: 0.4 }, motion: "pop" },
];

export function placementById(id: string) {
  return PLACEMENTS.find((p) => p.id === id) || null;
}

export function motionById(id: string) {
  return MOTIONS.find((m) => m.id === id) || MOTIONS[0];
}

export type MotionExprs = { dx: string; dy: string; scale: string };

/**
 * Remplit les gabarits d'un mouvement : `t` reste la variable de temps (ffmpeg
 * comme aperçu), tout le reste est remplacé par des nombres.
 */
export function motionExprs(motion: Motion | undefined, box: Box, duration: number): MotionExprs {
  const preset = motion?.preset && MOTION_TEMPLATES[motion.preset] ? motion.preset : "none";
  const amount = Math.max(0, Math.min(1, motion?.amount ?? 0.5));
  const template = MOTION_TEMPLATES[preset];
  const safeDuration = Math.max(0.05, duration).toFixed(3);
  const values: Record<string, string | number> = {
    A: Number(amount.toFixed(3)),
    BW: Number((box?.w ?? 0.34).toFixed(4)),
    BH: Number((box?.h ?? 0.34).toFixed(4)),
    // La progression est écrite en clair (durée numérique) : il ne doit rester
    // aucun jeton symbolique pour ffmpeg, qui ne connaît que `t`.
    P: `min(1,max(0,t/${safeDuration}))`,
  };
  const fill = (source: string) =>
    source.replace(/\b[A-Z]{1,3}\b/g, (token) => {
      if (!(token in values)) return token;
      const value = values[token];
      return typeof value === "number" ? String(Number(value.toFixed(4))) : String(value);
    });
  return { dx: fill(template.dx), dy: fill(template.dy), scale: fill(template.scale) };
}

/** Le mouvement produit-il une échelle variable (donc un filtre `scale` animé) ? */
export function hasAnimatedScale(motion: Motion | undefined) {
  const exprs = motionExprs(motion, { x: 0, y: 0, w: 1, h: 1 }, 1);
  return exprs.scale !== "1";
}

/** Charge utile exposée par GET /api/motions (l'aperçu utilise les mêmes gabarits). */
export function motionCatalog() {
  return { motions: MOTIONS, placements: PLACEMENTS, templates: MOTION_TEMPLATES };
}

/** Résumé lisible, pratique pour les infobulles de la timeline. */
export function describeOverlay(clip: OverlayClip) {
  const placement = PLACEMENTS.find(
    (p) => Math.abs(p.box.x - clip.box.x) < 0.001 && Math.abs(p.box.y - clip.box.y) < 0.001 && Math.abs(p.box.w - clip.box.w) < 0.001 && Math.abs(p.box.h - clip.box.h) < 0.001
  );
  const motion = motionById(clip.motion?.preset || "none");
  const where = placement ? placement.label : `x ${Math.round(clip.box.x * 100)}% · y ${Math.round(clip.box.y * 100)}% · ${Math.round(clip.box.w * 100)}%`;
  return `${motion.icon} ${motion.label} · ${where}`;
}
