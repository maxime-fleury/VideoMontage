/**
 * Images clés des incrustations : génération des expressions d'interpolation.
 *
 * Module **partagé** : le serveur l'importe pour écrire les filtres ffmpeg, et
 * l'aperçu l'importe pour évaluer exactement les mêmes expressions (via expr.js).
 * C'est la même garantie que pour les mouvements prédéfinis : une seule vérité,
 * donc aucun écart entre ce qui est affiché et ce qui est exporté.
 *
 * Chaque image clé décrit un état complet (position, taille, rotation, opacité) à
 * un instant local du clip. Entre deux images clés, chaque valeur est interpolée
 * selon la **courbe de vitesse** de l'image clé d'arrivée (`ease`), qui prend le
 * pas sur la courbe par défaut du clip (`ease` du clip).
 *
 * Les expressions produites ne contiennent que des nombres, `if`, `lt`, `gte`,
 * `pow`, `min`, `max` et la variable de temps (par défaut `t`) : ffmpeg n'accepte
 * aucun autre jeton — et notamment pas les opérateurs `<` / `>` qui cassent le
 * parseur des expressions de filtre (vérifié sur ffmpeg 8.1), d'où `lt(a,b)`.
 */
import { evalExpr } from "./expr.js";
import { newId } from "./api.js";

/** Courbes de vitesse disponibles pour un segment. */
export const EASE_IDS = ["linear", "smooth", "power", "hold"];

/** Bornes de l'exposant de la courbe « puissance ». */
export const MIN_POWER = 0.15;
export const MAX_POWER = 6;

export function clampPower(power) {
  const value = Number(power);
  if (!Number.isFinite(value) || value <= 0) return 2;
  return Math.min(MAX_POWER, Math.max(MIN_POWER, value));
}

/** Tronque un nombre pour garder des expressions courtes. */
function num(value) {
  const rounded = Number(value.toFixed(4));
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

/**
 * Progression 0..1 entre deux instants, avec la courbe choisie.
 *
 * - `linear` : vitesse constante
 * - `smooth` : départ et arrivée doux (smoothstep)
 * - `power`  : `p^exposant` — < 1 part vite et freine (arrivée douce), > 1 part
 *              lentement et accélère (départ doux)
 * - `hold`   : maintien de la valeur, puis saut sec sur l'image clé suivante
 */
function progressExpr(from, to, ease, token, power) {
  const span = Math.max(1e-4, to - from);
  const raw = `min(1,max(0,(${token}-${num(from)})/${num(span)}))`;
  switch (ease) {
    case "hold":
      // 0 tant qu'on n'est pas arrivé, 1 ensuite : la valeur tient puis saute
      return `gte(${token},${num(to)})`;
    case "power":
      return `pow(${raw},${num(clampPower(power))})`;
    case "smooth":
      return `(${raw}*${raw}*(3-2*${raw}))`;
    default:
      return raw;
  }
}

/** Valeur interpolée entre deux états, sous forme d'expression. */
export function lerpExpr(from, to, t1, t2, ease, token = "t", power) {
  return `(${num(from)}+(${num(to)}-${num(from)})*${progressExpr(t1, t2, ease, token, power)})`;
}

/**
 * Expression d'une suite d'états (un par image clé) : morceau par morceau, avec
 * les bornes tenues avant la première et après la dernière image clé. La courbe
 * utilisée pour un segment est celle de l'image clé d'arrivée.
 */
export function piecewiseExpr(states, defaultEase = "linear", token = "t") {
  if (!states.length) return "0";
  if (states.length === 1) return num(states[0].value);
  let expr = num(states[states.length - 1].value);
  for (let index = states.length - 2; index >= 0; index--) {
    const arriving = states[index + 1];
    const ease = EASE_IDS.includes(arriving.ease) ? arriving.ease : defaultEase;
    const segment = lerpExpr(
      states[index].value,
      arriving.value,
      states[index].t,
      arriving.t,
      ease,
      token,
      arriving.power
    );
    expr = `if(lt(${token},${num(arriving.t)}),${segment},${expr})`;
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
  const series = (pick) =>
    keys.map((key) => ({ t: key.t, value: pick(key), ease: key.ease, power: key.power }));
  const piece = (pick) => piecewiseExpr(series(pick), ease, token);

  const cx = piece(centerX);
  const cy = piece(centerY);
  const wf = piece((key) => box(key).w);
  const hf = piece((key) => box(key).h);
  const rot = piece((key) => Number(key.rotation) || 0);
  const op = piece((key) => Math.max(0, Math.min(1, key.opacity ?? 1)));

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
 * Allure d'une courbe 0..1, échantillonnée **avec l'expression du rendu** : le
 * petit graphe de l'éditeur montre donc exactement la vitesse qui sera exportée.
 */
export function curveSamples(ease, power, count = 16) {
  const expression = progressExpr(0, 1, ease, "t", power);
  const samples = [];
  for (let index = 0; index <= count; index++) {
    const t = index / count;
    try {
      samples.push(evalExpr(expression, { t }));
    } catch {
      samples.push(t);
    }
  }
  return samples;
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
  // pas de courbe propre : les deux segments héritent de la courbe par défaut du
  // clip (`ease`), que l'éditeur présente justement comme « héritée »
  return [
    { id: newId("kf"), t: 0, ...base, box: { ...base.box } },
    { id: newId("kf"), t: Number(duration.toFixed(3)), ...base, box: { ...base.box } },
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

/** Centre d'une image clé, en fractions du cadre (utilisé par le tracé). */
export function keyframeCenter(key, fallback) {
  const box = key.box || fallback || { x: 0, y: 0, w: 0.34, h: 0.34 };
  return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
}
