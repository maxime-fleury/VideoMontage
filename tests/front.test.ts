import { describe, expect, test } from "bun:test";
import { motionCatalog } from "../src/lib/motions";
// les modules testés sont ceux servis au navigateur (public/js), pas des copies
import { evalExpr, fillTemplate } from "../public/js/expr";
import { overlayAlpha, overlayGeometry } from "../public/js/geometry";
import { curveSamples, keyframeExprs, keysFromClip, piecewiseExpr, MAX_POWER, MIN_POWER } from "../public/js/keyframes";
import { applyChroma, contentRect, despill, hexToRgb, keyAlpha } from "../public/js/chroma";
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

describe("images clés des incrustations", () => {
  const start = { x: 0.1, y: 0.1, w: 0.3, h: 0.2 };
  const end = { x: 0.5, y: 0.3, w: 0.6, h: 0.4 };
  const animated = (over: any = {}) => ({
    ...clip(),
    duration: 4,
    box: { ...start },
    rotation: 0,
    opacity: 1,
    ease: "smooth",
    keys: [
      { t: 0, box: { ...start }, rotation: 0, opacity: 1 },
      { t: 4, box: { ...end }, rotation: 90, opacity: 0.5 },
    ],
    ...over,
  });

  test("deux états interpolés : position, taille, rotation et opacité", () => {
    const moving = animated();
    const atStart = overlayGeometry(moving, 0, CATALOG);
    const middle = overlayGeometry(moving, 2, CATALOG);
    const atEnd = overlayGeometry(moving, 4, CATALOG);

    expect(atStart.x).toBeCloseTo(start.x, 9);
    expect(atEnd.x).toBeCloseTo(end.x, 9);
    expect(middle.x).toBeCloseTo((start.x + end.x) / 2, 9);
    // la taille grandit dans le temps et la rotation suit la même courbe
    expect(middle.w).toBeCloseTo((start.w + end.w) / 2, 9);
    expect(middle.rotation).toBeCloseTo(45, 9);
    expect(atStart.keyframed).toBe(true);
    // opacité : 1 → 0.5, à mi-parcours la courbe douce donne exactement 0.75
    expect(overlayAlpha(moving, 0)).toBeCloseTo(1, 9);
    expect(overlayAlpha(moving, 2)).toBeCloseTo(0.75, 9);
    expect(overlayAlpha(moving, 4)).toBeCloseTo(0.5, 9);
  });

  test("avant la première et après la dernière image clé, l'état est tenu", () => {
    const moving = animated({ keys: [
      { t: 1, box: { ...start }, rotation: 10, opacity: 0.8 },
      { t: 3, box: { ...end }, rotation: 40, opacity: 0.4 },
    ] });
    const before = overlayGeometry(moving, 0, CATALOG);
    const first = overlayGeometry(moving, 1, CATALOG);
    expect(before.x).toBeCloseTo(first.x, 9);
    expect(before.rotation).toBeCloseTo(10, 9);
    expect(overlayAlpha(moving, 0)).toBeCloseTo(0.8, 9);
    const after = overlayGeometry(moving, 4, CATALOG);
    expect(after.rotation).toBeCloseTo(40, 9);
    expect(overlayAlpha(moving, 4.5)).toBeCloseTo(0.4, 9);
  });

  test("les expressions d'images clés restent évaluables et sans opérateur < >", () => {
    // garde-fou : les opérateurs `<` et `>` cassent le parseur d'expressions de
    // ffmpeg (vérifié sur 8.1) ; les expressions doivent utiliser lt()/gt()
    const kf = keyframeExprs(animated(), 4);
    for (const expression of [kf.cx, kf.cy, kf.wf, kf.hf, kf.rot, kf.op]) {
      expect(/[<>]/.test(expression)).toBe(false);
      for (const t of [0, 1.5, 2, 3.25, 4, 10]) {
        expect(Number.isFinite(evalExpr(expression, { t }))).toBe(true);
      }
    }
    // le temps passe bien par la variable demandée (geq utilise N/fps côté ffmpeg)
    const frames = keyframeExprs(animated(), 4, "(N/25.000)").op;
    expect(frames).toContain("N/25.000");
    expect(evalExpr(frames, { N: 0 })).toBeCloseTo(1, 9);
  });

  test("les courbes de vitesse changent la progression, sans changer les bornes", () => {
    const at = (ease, power, t) => evalExpr(piecewiseExpr([
      { t: 0, value: 0 },
      { t: 1, value: 1, ease, power },
    ], "linear"), { t });

    // bornes toujours tenues, quelle que soit la courbe
    for (const ease of ["linear", "smooth", "power", "hold"]) {
      expect(at(ease, 2, 0)).toBeCloseTo(0, 9);
      expect(at(ease, 2, 1)).toBeCloseTo(1, 9);
      expect(at(ease, 2, 2)).toBeCloseTo(1, 9);
    }
    expect(at("linear", 2, 0.5)).toBeCloseTo(0.5, 9);
    expect(at("smooth", 2, 0.5)).toBeCloseTo(0.5, 9);
    expect(at("smooth", 2, 0.25)).toBeCloseTo(0.15625, 9); // 3p² − 2p³
    // puissance > 1 : départ lent ; puissance < 1 : départ rapide
    expect(at("power", 3, 0.5)).toBeCloseTo(0.125, 9);
    expect(at("power", 0.5, 0.25)).toBeCloseTo(0.5, 9);
    // maintien : la valeur tient jusqu'à l'image clé, puis saute
    expect(at("hold", 2, 0.99)).toBe(0);
    expect(at("hold", 2, 1)).toBe(1);
  });

  test("la courbe propre à une image clé prime sur la courbe par défaut du clip", () => {
    const keys = [
      { t: 0, value: 0 },
      { t: 1, value: 1, ease: "hold" },
      { t: 2, value: 2 },
    ];
    const expression = piecewiseExpr(keys, "linear");
    expect(evalExpr(expression, { t: 0.5 })).toBe(0); // segment 1 : maintien (courbe portée par l'image clé #2)
    expect(evalExpr(expression, { t: 1.5 })).toBeCloseTo(1.5, 9); // segment 2 : linéaire (courbe par défaut)
    // le segment 2 n'a pas de courbe propre : il suit la courbe par défaut du clip
    const smooth = piecewiseExpr(keys, "smooth");
    expect(evalExpr(smooth, { t: 1.25 })).toBeCloseTo(1.15625, 9); // 3p² − 2p³ à p = 0.25
    expect(evalExpr(smooth, { t: 1.5 })).toBeCloseTo(1.5, 9);
  });

  test("les courbes restent dans les bornes annoncées à l'éditeur", () => {
    const samples = curveSamples("power", 99);
    expect(samples[0]).toBeCloseTo(0, 9);
    expect(samples[samples.length - 1]).toBeCloseTo(1, 9);
    for (const value of samples) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
    // l'exposant est borné : un réglage extrême ne fige pas la courbe
    const clamped = curveSamples("power", MAX_POWER + 10);
    expect(clamped[Math.floor(clamped.length / 2)]).toBeGreaterThan(0);
    const tiny = curveSamples("power", MIN_POWER - 10);
    expect(tiny[1]).toBeGreaterThan(0);
    expect(tiny[tiny.length - 1]).toBeCloseTo(1, 9);
  });

  test("les expressions de courbe n'utilisent ni < ni > (parseur ffmpeg)", () => {
    for (const ease of ["linear", "smooth", "power", "hold"]) {
      const expression = piecewiseExpr([
        { t: 0, value: 0 },
        { t: 1.5, value: 1, ease, power: 2 },
        { t: 3, value: 0.2, ease },
      ], "linear");
      expect(/[<>]/.test(expression)).toBe(false);
      for (const t of [0, 0.4, 1.5, 2.2, 3, 5]) {
        expect(Number.isFinite(evalExpr(expression, { t }))).toBe(true);
      }
    }
  });

  test("keysFromClip part de l'état actuel et couvre toute la durée", () => {
    const keys = keysFromClip({ ...clip(), duration: 2.5, box: { ...BOX }, rotation: 12, opacity: 0.7 });
    expect(keys).toHaveLength(2);
    expect(keys[0].t).toBe(0);
    expect(keys[1].t).toBeCloseTo(2.5, 6);
    expect(keys[0].box).toEqual({ ...BOX });
    expect(keys[1].rotation).toBe(12);
    expect(keys[1].opacity).toBeCloseTo(0.7, 6);
  });
});

describe("clé chromatique (mêmes formules que ffmpeg)", () => {
  const GREEN = hexToRgb("#00ff00");

  test("colorkey : distance normalisée et rampe de mélange", () => {
    // pixel exactement sur la couleur-clé → transparent
    expect(keyAlpha(0, 255, 0, GREEN, 0.3, 0.1)).toBe(0);
    // pixel très éloigné (blanc) → opaque
    expect(keyAlpha(255, 255, 255, GREEN, 0.3, 0.1)).toBe(1);
    // rampe : sur le canal de l'écran, la distance vaut exactement l'écart normalisé
    // (200 - 255) / (255√3) = 0.1245 < 0.3 → encore transparent
    expect(keyAlpha(0, 200, 0, GREEN, 0.3, 0.1)).toBe(0);
    // (100 - 255) / (255√3) = 0.3509 → dans la rampe : alpha ≈ (0.3509 - 0.3) / 0.1
    const ramped = keyAlpha(0, 100, 0, GREEN, 0.3, 0.1);
    expect(ramped).toBeGreaterThan(0.4);
    expect(ramped).toBeLessThan(0.6);
    // mélange nul → seuil net (comportement de ffmpeg avec blend=0)
    expect(keyAlpha(0, 100, 0, GREEN, 0.3, 0)).toBe(1);
    expect(keyAlpha(0, 200, 0, GREEN, 0.3, 0)).toBe(0);
  });

  test("despill : le canal de l'écran est réduit, pas les autres", () => {
    const spilled = despill(120, 210, 100, GREEN);
    expect(spilled.g).toBeLessThan(210);
    expect(spilled.r).toBeCloseTo(120, 6);
    expect(spilled.b).toBeCloseTo(100, 6);
    // un pixel sans reflet n'est pas touché
    const clean = despill(120, 90, 100, GREEN);
    expect(clean.g).toBeCloseTo(90, 6);
    // écran bleu : c'est le bleu qui est réduit
    const blue = despill(120, 90, 230, hexToRgb("#0000ff"));
    expect(blue.b).toBeLessThan(230);
    expect(blue.g).toBeCloseTo(90, 6);
  });

  test("applyChroma modifie l'alpha et nettoie la couleur des pixels détourés", () => {
    const data = new Uint8ClampedArray([
      0, 255, 0, 255, // écran vert → transparent
      255, 255, 255, 255, // sujet clair → opaque
      0, 100, 0, 255, // dans la rampe → alpha partiel
    ]);
    applyChroma({ data }, { enabled: true, color: "#00ff00", similarity: 0.3, blend: 0.25, despill: false });
    expect(data[3]).toBe(0);
    expect(data[7]).toBe(255);
    expect(data[11]).toBeGreaterThan(0);
    expect(data[11]).toBeLessThan(255);
    // sous un alpha nul, la couleur est neutralisée (pas de halo de couleur)
    expect(data[0] + data[1] + data[2]).toBe(0);
    // désactivée, le média reste intact
    const intact = new Uint8ClampedArray([0, 255, 0, 255]);
    applyChroma({ data: intact }, { enabled: false, color: "#00ff00", similarity: 0.3, blend: 0.1, despill: true });
    expect([...intact]).toEqual([0, 255, 0, 255]);
  });

  test("contentRect reproduit object-fit (pipette précise)", () => {
    // média 4:3 dans une boîte 16:9 : « cover » recadre en hauteur, « contain » laisse des marges
    const cover = contentRect(160, 120, 320, 180, "cover");
    expect(cover.width).toBeCloseTo(320, 6);
    expect(cover.height).toBeCloseTo(240, 6);
    expect(cover.top).toBeCloseTo(-30, 6);
    const contain = contentRect(160, 120, 320, 180, "contain");
    expect(contain.width).toBeCloseTo(240, 6);
    expect(contain.height).toBeCloseTo(180, 6);
    expect(contain.left).toBeCloseTo(40, 6);
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
