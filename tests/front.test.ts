import { describe, expect, test } from "bun:test";
import { motionCatalog } from "../src/lib/motions";
// les modules testés sont ceux servis au navigateur (public/js), pas des copies
import { evalExpr, fillTemplate } from "../public/js/expr";
import { overlayAlpha, overlayGeometry } from "../public/js/geometry";
import { DEFAULT_W, MIN_COL, columnLayout, columnWidth } from "../public/js/layoutmath";
import { reconcile } from "../public/js/state";

const CATALOG = motionCatalog();
const BOX = { x: 0.6, y: 0.6, w: 0.34, h: 0.34 };
const clip = (over: any = {}) => ({
  id: "ovl",
  start: 0,
  duration: 4,
  box: { ...BOX },
  opacity: 1,
  fadeIn: 0,
  fadeOut: 0,
  motion: { preset: "none", amount: 0.5 },
  ...over,
});

describe("géométrie de l'aperçu", () => {
  test("sans mouvement, l'incrustation occupe exactement sa case du cadre", () => {
    const geometry = overlayGeometry(clip(), 1, CATALOG);
    expect(geometry.x).toBeCloseTo(BOX.x, 12);
    expect(geometry.y).toBeCloseTo(BOX.y, 12);
    expect(geometry.w).toBeCloseTo(BOX.w, 12);
    expect(geometry.h).toBeCloseTo(BOX.h, 12);
    expect(geometry.scale).toBeCloseTo(1, 12);
  });

  test("un zoom garde le centre et grandit dans le temps", () => {
    const zoom = clip({ motion: { preset: "zoom-in", amount: 0.6 } });
    const start = overlayGeometry(zoom, 0, CATALOG);
    const end = overlayGeometry(zoom, 3.9, CATALOG);
    expect(end.w).toBeGreaterThan(start.w);
    // le centre de la case ne bouge pas (seule l'échelle change)
    expect(start.x + start.w / 2).toBeCloseTo(end.x + end.w / 2, 9);
    expect(start.y + start.h / 2).toBeCloseTo(end.y + end.h / 2, 9);
  });

  test("une dérive horizontale reste bornée et symétrique", () => {
    const drift = clip({ motion: { preset: "drift-left", amount: 1 } });
    const start = overlayGeometry(drift, 0, CATALOG);
    const middle = overlayGeometry(drift, 2, CATALOG);
    const end = overlayGeometry(drift, 4, CATALOG);
    expect(start.x).toBeGreaterThan(end.x);
    expect(middle.x).toBeCloseTo(BOX.x, 6);
    expect(Math.abs(start.x - BOX.x + (end.x - BOX.x))).toBeLessThan(1e-6);
  });

  test("un mouvement inconnu retombe sur un rendu fixe (aucun plantage)", () => {
    const unknown = clip({ motion: { preset: "preset-inexistant", amount: 0.5 } });
    const geometry = overlayGeometry(unknown, 2, CATALOG);
    expect(geometry.w).toBeCloseTo(BOX.w, 12);
    expect(Number.isFinite(geometry.x)).toBe(true);
  });

  test("le fondu d'entrée et de sortie encadre l'opacité de base", () => {
    const fading = clip({ opacity: 0.8, fadeIn: 1, fadeOut: 1 });
    expect(overlayAlpha(fading, 0)).toBe(0);
    expect(overlayAlpha(fading, 0.5)).toBeCloseTo(0.4, 9);
    expect(overlayAlpha(fading, 2)).toBeCloseTo(0.8, 9);
    expect(overlayAlpha(fading, 4)).toBe(0);
    expect(overlayAlpha(fading, 3.5)).toBeCloseTo(0.4, 9);
    // les fondus ne peuvent pas dépasser la moitié du clip
    const silly = clip({ fadeIn: 40, fadeOut: 40 });
    expect(overlayAlpha(silly, 2)).toBe(1);
  });
});

describe("largeurs de colonnes (plus de vide quand une colonne est masquée)", () => {
  test("les valeurs par défaut correspondent à la disposition de repli", () => {
    expect(columnWidth("left", {})).toBe(DEFAULT_W.left);
    expect(columnWidth("center", {})).toBe(DEFAULT_W.center);
    expect(columnWidth("right", {})).toBe(DEFAULT_W.right);
  });

  test("une largeur mémorisée est bornée et arrondie", () => {
    expect(columnWidth("left", { left: 42 })).toBe(MIN_COL);
    expect(columnWidth("left", { left: 612.4 })).toBe(612);
    expect(columnWidth("left", { left: "beaucoup" })).toBe(DEFAULT_W.left);
  });

  test("la règle flex est proportionnelle : autant de croissance que de base", () => {
    const layout = columnLayout("center", { center: 700 });
    expect(layout.flex).toBe("700 1 700px");
    const [basis, grow, growBasis] = layout.flex.split(" ");
    // base et facteur de croissance portent la même largeur : le partage de la
    // place restante est donc proportionnel à la largeur de chaque colonne
    expect(Number(basis)).toBe(layout.width);
    expect(grow).toBe("1");
    expect(growBasis).toBe(`${layout.width}px`);
  });
});

describe("fusion d'identité des projets (adoptProject)", () => {
  test("les objets connus gardent leur identité, les nouveaux passent tels quels", () => {
    const previous = {
      id: "prj_1",
      videoTrack: [{ id: "clip_a", start: 0, effect: { fadeIn: 0.4 } }],
      overlayLayers: [{ id: "lyr_1", clips: [{ id: "ovl_1", start: 1 }] }],
      texts: [{ id: "txt_1", text: "Salut" }],
      audioTracks: [{ id: "trk_1", clips: [{ id: "aud_1" }] }],
    };
    const knownClip = previous.videoTrack[0];
    const knownEffect = previous.videoTrack[0].effect;
    const knownLayer = previous.overlayLayers[0];
    const knownOverlay = previous.overlayLayers[0].clips[0];
    const knownText = previous.texts[0];
    const knownTrack = previous.audioTracks[0];

    const next = {
      id: "prj_1",
      videoTrack: [
        { id: "clip_a", start: 12, effect: { fadeIn: 0.9 } },
        { id: "clip_b", start: 20, effect: { fadeIn: 0.2 } },
      ],
      overlayLayers: [{ id: "lyr_1", clips: [{ id: "ovl_1", start: 4 }, { id: "ovl_2" }] }],
      texts: [{ id: "txt_1", text: "Salut !" }],
      audioTracks: [{ id: "trk_1", clips: [{ id: "aud_1", gain: 2 }] }],
    };

    const merged = reconcile(previous, next);
    expect(merged).toBe(previous);
    expect(merged.videoTrack[0]).toBe(knownClip);
    expect(merged.videoTrack[0].effect).toBe(knownEffect);
    expect(merged.videoTrack[0].start).toBe(12);
    expect(merged.videoTrack[0].effect.fadeIn).toBe(0.9);
    expect(merged.videoTrack[1].id).toBe("clip_b");
    expect(merged.overlayLayers[0]).toBe(knownLayer);
    expect(merged.overlayLayers[0].clips[0]).toBe(knownOverlay);
    expect(merged.overlayLayers[0].clips[0].start).toBe(4);
    expect(merged.overlayLayers[0].clips[1].id).toBe("ovl_2");
    expect(merged.texts[0]).toBe(knownText);
    expect(merged.texts[0].text).toBe("Salut !");
    expect(merged.audioTracks[0]).toBe(knownTrack);
    expect(merged.audioTracks[0].clips[0].gain).toBe(2);
  });

  test("une liste vidée côté serveur ne ressuscite pas les anciens objets", () => {
    const merged = reconcile({ items: [{ id: "a" }, { id: "b" }] }, { items: [] });
    expect(merged.items).toEqual([]);
  });
});

describe("évaluation des gabarits côté navigateur", () => {
  test("tous les gabarits du serveur sont évaluables par l'aperçu", () => {
    for (const motion of CATALOG.motions) {
      const template = CATALOG.templates[motion.id];
      const filled = {
        dx: fillTemplate(template.dx, { D: 4, A: 0.5, BW: 0.34, BH: 0.34, P: 0.5 }),
        dy: fillTemplate(template.dy, { D: 4, A: 0.5, BW: 0.34, BH: 0.34, P: 0.5 }),
        scale: fillTemplate(template.scale, { D: 4, A: 0.5, BW: 0.34, BH: 0.34, P: 0.5 }),
      };
      for (const expression of Object.values(filled)) {
        expect(Number.isFinite(evalExpr(expression, { t: 2 }))).toBe(true);
      }
    }
  });

  test("une variable non remplie est une erreur explicite (jamais un NaN silencieux)", () => {
    const partial = fillTemplate("BW * 2 + P", { BW: 0.34 });
    expect(() => evalExpr(partial, { t: 1 })).toThrow();
  });
});
