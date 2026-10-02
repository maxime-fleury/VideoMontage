import { describe, expect, test } from "bun:test";
import {
  MAX_KEYFRAMES,
  MAX_OVERLAY_LAYERS,
  normalizeChroma,
  normalizeOverlayClip,
  normalizeOverlayLayer,
  normalizeOverlayLayers,
  normalizeTextOverlay,
} from "../src/lib/validate";

describe("validation des incrustations et des textes", () => {
  test("la limite de calques est refusée côté serveur, pas seulement dans l'interface", () => {
    expect(MAX_OVERLAY_LAYERS).toBe(3);
    const layer = (id: string) => ({ id, name: id, clips: [] });
    expect(normalizeOverlayLayers([layer("a"), layer("b"), layer("c")])).toHaveLength(3);
    // 4 calques : refusé (l'interface et le rendu supposent 3 au maximum)
    expect(normalizeOverlayLayers([layer("a"), layer("b"), layer("c"), layer("d")])).toBeNull();
    expect(normalizeOverlayLayers("n'importe quoi")).toBeNull();
  });

  test("un clip d'incrustation est borné et complété", () => {
    const clip = normalizeOverlayClip({ sourceId: "src_1", start: -5, duration: 0, box: { x: 2, y: 2, w: 0, h: 0 } });
    expect(clip.start).toBe(0);
    expect(clip.duration).toBe(3); // durée par défaut, jamais nulle
    expect(clip.box.x).toBe(2); // borné à 2 : une incrustation peut sortir à moitié du cadre
    expect(clip.box.w).toBe(0.34); // 0 est une valeur « vide » : on retombe sur la taille par défaut
    expect(clip.fit).toBe("cover");
    expect(clip.motion.preset).toBe("none");
    expect(clip.audio.mute).toBe(true);

    const known = normalizeOverlayClip({ motion: { preset: "drift-left", amount: 5 } });
    expect(known.motion.preset).toBe("drift-left");
    expect(known.motion.amount).toBe(1);

    const bogus = normalizeOverlayClip({ motion: { preset: "preset-inconnu" } });
    expect(bogus.motion.preset).toBe("none");
  });

  test("un calque garde ses identifiants et reçoit un nom par défaut", () => {
    const layer = normalizeOverlayLayer({ id: "lyr_1" }, 0);
    expect(layer.id).toBe("lyr_1");
    expect(layer.name).toBe("Vidéo 2");
    expect(layer.clips).toEqual([]);
    const second = normalizeOverlayLayer({}, 1);
    expect(second.name).toBe("Vidéo 3");
  });

  test("un texte libre est borné (couleurs, alignement, animations)", () => {
    const text = normalizeTextOverlay({
      text: "Salut",
      box: { x: 0.5, y: 0.5, w: 0.2, h: 0.1 },
      style: { color: "pas-une-couleur", size: 99, align: "diagonale", outlineWidth: -3 },
      animation: { in: "inconnu", out: "inconnu", duration: 0 },
    });
    expect(text.style.color).toBe("#ffffff");
    expect(text.style.size).toBe(0.6);
    expect(text.style.align).toBe("center");
    expect(text.style.outlineWidth).toBe(0);
    expect(text.animation.in).toBe("fade");
    expect(text.animation.out).toBe("fade");
    expect(text.animation.duration).toBe(0.35);
    expect(text.style.font).toBe("Outfit");
  });

  test("les images clés sont triées, bornées et limitées", () => {
    const clip = normalizeOverlayClip({
      keys: [
        { t: 3, box: { x: 0, y: 0, w: 0.3, h: 0.2 }, rotation: 400, opacity: 5 },
        { t: -1, box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, rotation: 12, opacity: -2 },
      ],
      ease: "smooth",
    });
    expect(clip.keys).toHaveLength(2);
    expect(clip.keys![0].t).toBe(0);
    expect(clip.keys![1].t).toBe(3);
    expect(clip.keys![1].rotation).toBe(180);
    expect(clip.keys![1].opacity).toBe(1);
    expect(clip.keys![0].opacity).toBe(0);
    expect(clip.ease).toBe("smooth");

    // au-delà du plafond, on garde les premières : le rendu ne s'alourdit pas
    const many = normalizeOverlayClip({ keys: Array.from({ length: 30 }, (_, i) => ({ t: i })) });
    expect(many.keys).toHaveLength(MAX_KEYFRAMES);

    // aucune image clé → mouvement prédéfini, comme avant
    expect(normalizeOverlayClip({ keys: [] }).keys).toBeUndefined();
    expect(normalizeOverlayClip({}).ease).toBe("linear");
  });

  test("une clé chromatique est bornée et retombe sur le vert", () => {
    const chroma = normalizeChroma({ enabled: true, color: "rouge", similarity: 4, blend: -2, despill: false });
    expect(chroma.enabled).toBe(true);
    expect(chroma.color).toBe("#00ff00");
    expect(chroma.similarity).toBe(1);
    expect(chroma.blend).toBe(0);
    expect(chroma.despill).toBe(false);

    const off = normalizeChroma(null);
    expect(off.enabled).toBe(false);
    expect(off.despill).toBe(true);
    expect(off.similarity).toBeCloseTo(0.3, 6);
  });
});
