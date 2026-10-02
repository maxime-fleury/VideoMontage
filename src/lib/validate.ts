import { clamp, newId, sanitizeText } from "./util";
import { MOTIONS } from "./motions";
import type { MotionPresetId, OverlayClip, OverlayLayer, TextOverlay } from "./store";

/**
 * Nombre maximal de pistes de superposition. Appliqué ici (donc pour toute
 * route qui écrit un projet) et non plus seulement dans l'interface : l'aperçu
 * et le rendu empilent tous les calques, la limite est une contrainte du modèle.
 * Le front garde la même valeur dans public/js/tracks.js.
 */
export const MAX_OVERLAY_LAYERS = 3;

const MOTION_IDS = new Set<string>(MOTIONS.map((m) => m.id));

const TEXT_ANIM_IN = ["none", "fade", "pop", "slide-up", "slide-down", "slide-left", "slide-right", "typewriter", "word-highlight"];
const TEXT_ANIM_OUT = ["none", "fade", "pop", "slide"];

const hexColor = (value: unknown, fallback: string) =>
  typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : fallback;

/** Valide une incrustation reçue du navigateur (bornes + identifiants connus). */
export function normalizeOverlayClip(raw: any): OverlayClip {
  return {
    id: String(raw?.id || newId("ovl")),
    sourceId: String(raw?.sourceId || ""),
    start: clamp(Number(raw?.start) || 0, 0, 1e6),
    duration: clamp(Number(raw?.duration) || 3, 0.05, 3600),
    offset: Math.max(0, Number(raw?.offset) || 0),
    box: {
      x: clamp(Number(raw?.box?.x) || 0, -1, 2),
      y: clamp(Number(raw?.box?.y) || 0, -1, 2),
      w: clamp(Number(raw?.box?.w) || 0.34, 0.02, 2),
      h: clamp(Number(raw?.box?.h) || 0.34, 0.02, 2),
    },
    fit: raw?.fit === "contain" ? "contain" : "cover",
    opacity: clamp(Number(raw?.opacity ?? 1), 0, 1),
    rotation: clamp(Number(raw?.rotation) || 0, -180, 180),
    motion: {
      preset: (MOTION_IDS.has(String(raw?.motion?.preset)) ? String(raw.motion.preset) : "none") as MotionPresetId,
      amount: clamp(Number(raw?.motion?.amount ?? 0.5), 0, 1),
    },
    fadeIn: clamp(Number(raw?.fadeIn) || 0, 0, 10),
    fadeOut: clamp(Number(raw?.fadeOut) || 0, 0, 10),
    audio: { mute: raw?.audio?.mute !== false, gain: clamp(Number(raw?.audio?.gain ?? 1), 0, 4) },
    createdAt: Number(raw?.createdAt) || Date.now(),
  };
}

/** Valide un texte libre reçu du navigateur. */
export function normalizeTextOverlay(raw: any): TextOverlay {
  const style = raw?.style || {};
  const animation = raw?.animation || {};
  return {
    id: String(raw?.id || newId("txt")),
    text: sanitizeText(String(raw?.text ?? ""), "").slice(0, 600),
    start: clamp(Number(raw?.start) || 0, 0, 1e6),
    duration: clamp(Number(raw?.duration) || 2.5, 0.05, 3600),
    box: {
      x: clamp(Number(raw?.box?.x) || 0.15, -1, 2),
      y: clamp(Number(raw?.box?.y) || 0.22, -1, 2),
      w: clamp(Number(raw?.box?.w) || 0.7, 0.05, 2),
      h: clamp(Number(raw?.box?.h) || 0.12, 0.02, 2),
    },
    rotation: clamp(Number(raw?.rotation) || 0, -180, 180),
    z: clamp(Number(raw?.z) || 0, -50, 50),
    style: {
      font: String(style.font || "Outfit").slice(0, 60),
      size: clamp(Number(style.size) || 0.07, 0.01, 0.6),
      bold: style.bold !== false,
      italic: !!style.italic,
      color: hexColor(style.color, "#ffffff"),
      highlightColor: hexColor(style.highlightColor, "#ffd166"),
      outlineColor: hexColor(style.outlineColor, "#1a1030"),
      outlineWidth: clamp(Number(style.outlineWidth) || 0, 0, 40),
      shadow: clamp(Number(style.shadow) || 0, 0, 80),
      background: hexColor(style.background, ""),
      padding: clamp(Number(style.padding) || 0, 0, 80),
      uppercase: !!style.uppercase,
      letterSpacing: clamp(Number(style.letterSpacing) || 0, -20, 60),
      lineHeight: clamp(Number(style.lineHeight) || 1.15, 0.6, 3),
      align: ["left", "center", "right"].includes(style.align) ? style.align : "center",
    },
    animation: {
      in: (TEXT_ANIM_IN.includes(animation.in) ? animation.in : "fade") as TextOverlay["animation"]["in"],
      out: (TEXT_ANIM_OUT.includes(animation.out) ? animation.out : "fade") as TextOverlay["animation"]["out"],
      duration: clamp(Number(animation.duration) || 0.35, 0.05, 4),
    },
    createdAt: Number(raw?.createdAt) || Date.now(),
  };
}

/** Valide un calque de superposition complet (identité + clips). */
export function normalizeOverlayLayer(raw: any, index: number): OverlayLayer {
  return {
    id: String(raw?.id || newId("lyr")),
    name: String(raw?.name || `Vidéo ${index + 2}`).slice(0, 60),
    hidden: !!raw?.hidden,
    clips: (Array.isArray(raw?.clips) ? raw.clips : []).map(normalizeOverlayClip),
  };
}

/**
 * Valide une liste de calques. Renvoie `null` si la limite est dépassée :
 * l'appelant répond alors 400 plutôt que d'accepter un projet irrenderable.
 */
export function normalizeOverlayLayers(raw: unknown): OverlayLayer[] | null {
  if (!Array.isArray(raw)) return null;
  if (raw.length > MAX_OVERLAY_LAYERS) return null;
  return raw.map((layer, index) => normalizeOverlayLayer(layer, index));
}
