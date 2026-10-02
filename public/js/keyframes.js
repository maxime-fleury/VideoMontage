/**
 * Images clés des incrustations : génération des expressions d'interpolation.
 *
 * Module **partagé** : le serveur l'importe pour écrire les filtres ffmpeg, et
 * l'aperçu l'importe pour évaluer exactement les mêmes expressions (via expr.js).
 * C'est la même garantie que pour les mouvements prédéfinis : une seule vérité,
 * donc aucun écart entre ce qui est affiché et ce qui est exporté.
 *
 * Chaque image clé décrit un état complet (position, taille, rotation, opacité) à
 * un instant local du clip. Entre deux images clés, chaque valeur est interpolée.
 *
 * Les expressions produites ne contiennent que des nombres, `if`, `lt`, `min`,
 * `max` et la variable de temps (par défaut `t`) : ffmpeg n'accepte aucun autre
 * jeton — et notamment pas les opérateurs `<` / `>` qui cassent le parseur des
 * expressions de filtre (vérifié sur ffmpeg 8.1), d'où `lt(a,b)`.
 */

/** Tronque un nombre pour garder des expressions courtes. */
function num(value) {
  const rounded = Number(value.toFixed(4));
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

/**
 * Progression 0..1 entre deux instants, avec la courbe choisie.
 * `smooth` = ease-in-out (départ et arrivée doux), `linear` = vitesse constante.
 */
function progressExpr(from, to, ease, token) {
  const span = Math.max(1e-4, to - from);
  const raw = `min(1,max(0,(${token}-${num(from)})/${num(span)}))`;
  if (ease === "smooth") return `(${raw}*${raw}*(3-2*${raw}))`;
  return raw;
}

/** Valeur interpolée entre deux états, sous forme d'expression. */
export function lerpExpr(from, to, t1, t2, ease, token = "t") {
  return `(${num(from)}+(${num(to)}-${num(from)})*${progressExpr(t1, t2, ease, token)})`;
}

/**
 * Expression d'une suite d'états (un par image clé) : linéaire par morceaux,
 * avec les bornes tenues avant la première et après la dernière image clé.
 */
export function piecewiseExpr(states, ease, token = "t") {
  if (!states.length) return "0";
  if (states.length === 1) return num(states[0].value);
  let expr = num(states[states.length - 1].value);
  for (let index = states.length - 2; index >= 0; index--) {
    const segment = lerpExpr(states[index].value, states[index + 1].value, states[index].t, states[index + 1].t, ease, token);
    expr = `if(lt(${token},${num(states[index + 1].t)}),${segment},${expr})`;
  }
  return expr;
}

const differs = (keys, pick) => keys.some((key, index) => index > 0 && Math.abs(pick(key) - pick(keys[0])) > 1e-6);

/** Une incrustation a-t-elle des images clés exploitables ? */
export function hasKeyframes(clip) {
  return !!clip && Array.isArray(clip.keys) && clip.keys.length > 0;
}

/**
 * Expressions d'une incrustation à images clés, à un instant local.
 *
 * - `cx`/`cy` : centre du cadre, en fraction de la largeur/hauteur de sortie
 * - `wf`/`hf` : largeur/hauteur, en fraction du cadre
 * - `rot`     : rotation en degrés (sens de l'écran)
 * - `op`      : opacité 0..1
 * - `varies`  : ce qui bouge réellement (utile pour ne pas animer inutilement)
 */
export function keyframeExprs(clip, duration, token = "t") {
  const keys = (clip.keys || []).slice().sort((a, b) => a.t - b.t);
  const ease = clip.ease === "smooth" ? "smooth" : "linear";
  const box = (key) => key.box || clip.box || { x: 0, y: 0, w: 0.34, h: 0.34 };
  const centerX = (key) => box(key).x + box(key).w / 2;
  const centerY = (key) => box(key).y + box(key).h / 2;
  const series = (pick) => keys.map((key) => ({ t: key.t, value: pick(key) }));

  const cx = piecewiseExpr(series(centerX), ease, token);
  const cy = piecewiseExpr(series(centerY), ease, token);
  const wf = piecewiseExpr(series((key) => box(key).w), ease, token);
  const hf = piecewiseExpr(series((key) => box(key).h), ease, token);
  const rot = piecewiseExpr(series((key) => Number(key.rotation) || 0), ease, token);
  const op = piecewiseExpr(series((key) => Math.max(0, Math.min(1, key.opacity ?? 1))), ease, token);

  const first = keys[0] || { box: clip.box, rotation: clip.rotation, opacity: clip.opacity };
  const varies = {
    pos: differs(keys, centerX) || differs(keys, centerY),
    size: differs(keys, (key) => box(key).w) || differs(keys, (key) => box(key).h),
    rot: differs(keys, (key) => Number(key.rotation) || 0),
    op: differs(keys, (key) => Math.max(0, Math.min(1, key.opacity ?? 1))),
  };
  void duration;

  return { cx, cy, wf, hf, rot, op, varies, first, ease, count: keys.length };
}

/**
 * Crée deux images clés (début et fin) à partir de l'état actuel d'une
 * incrustation : le rendu ne change pas tant que l'on ne bouge rien, mais les
 * poignées apparaissent et chaque réglage devient animable.
 */
export function keysFromClip(clip) {
  const duration = Math.max(0.1, Number(clip.duration) || 2.5);
  const box = clip.box || { x: 0.15, y: 0.22, w: 0.7, h: 0.12 };
  const base = {
    box: { ...box },
    rotation: Number(clip.rotation) || 0,
    opacity: Math.max(0, Math.min(1, clip.opacity ?? 1)),
  };
  return [
    { t: 0, ...base, box: { ...base.box } },
    { t: Number(duration.toFixed(3)), ...base, box: { ...base.box } },
  ];
}

/** Nombre maximal d'images clés par incrustation (au-delà, le rendu s'alourdit). */
export const MAX_KEYFRAMES = 12;

/** Image clé active pour un instant donné : la plus proche, sinon null. */
export function keyframeAt(clip, local, tolerance = 0.25) {
  const keys = clip.keys || [];
  let best = null;
  for (const key of keys) {
    if (!best || Math.abs(key.t - local) < Math.abs(best.t - local)) best = key;
  }
  if (best && Math.abs(best.t - local) <= tolerance) return best;
  return null;
}
