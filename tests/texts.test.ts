import { describe, expect, test } from "bun:test";
import { buildTextsAss, hasTexts, textEvents } from "../src/lib/texts";
import { defaultTextAnimation, defaultTextStyle, type Project, type TextOverlay } from "../src/lib/store";

const makeText = (overrides: Partial<TextOverlay> = {}): TextOverlay => ({
  id: "txt_test",
  text: "Bonjour",
  start: 1,
  duration: 2.5,
  box: { x: 0.15, y: 0.2, w: 0.7, h: 0.12 },
  rotation: 0,
  z: 1,
  style: { ...defaultTextStyle() },
  animation: { ...defaultTextAnimation() },
  createdAt: Date.now(),
  ...overrides,
});

const project = (texts: TextOverlay[]): Project =>
  ({
    id: "prj_test",
    name: "Test",
    createdAt: 0,
    updatedAt: 0,
    sources: [],
    voice: { edits: { cuts: [], ffwd: [], ffwdFactor: 100, denoise: { mode: "none", reduction: 12 }, normalize: false } },
    videoTrack: [],
    audioTracks: [],
    overlayLayers: [],
    texts,
    output: { width: 1920, height: 1080, fps: 30, normalize: true, crf: 20 },
  }) as Project;

describe("textes libres", () => {
  test("hasTexts ignore les textes vides", () => {
    expect(hasTexts(project([]))).toBe(false);
    expect(hasTexts(project([makeText({ text: "   " })]))).toBe(false);
    expect(hasTexts(project([makeText()]))).toBe(true);
  });

  test("le fichier .ass déclare une police et une taille cohérentes avec la hauteur", () => {
    const ass = buildTextsAss(project([makeText({ style: { ...defaultTextStyle(), font: "Anton", size: 0.1 } })]), 1920, 1080);
    expect(ass).toContain("PlayResX: 1920");
    expect(ass).toContain("PlayResY: 1080");
    // 0.1 de 1080 = 108 px
    expect(ass).toMatch(/Style: T0,Anton,108,/);
  });

  test("les positions suivent le cadre exprimé en fractions", () => {
    const text = makeText({ box: { x: 0.0, y: 0.0, w: 1, h: 0.1 } });
    const events = textEvents(text, 1920, 1080);
    expect(events).toHaveLength(1);
    // centré horizontalement, 5 % de la hauteur
    expect(events[0].tags).toContain("\\pos(960,54)");
  });

  test("les caractères réservés de libass sont neutralisés", () => {
    const ass = buildTextsAss(project([makeText({ text: "a{b}c\\d" })]), 1920, 1080);
    expect(ass).toContain("a(b)c\\\\d");
    expect(ass).not.toContain("{b}");
  });

  test("les retours à la ligne deviennent des sauts ASS", () => {
    const events = textEvents(makeText({ text: "ligne 1\nligne 2" }), 1920, 1080);
    expect(events[0].text).toContain("\\N");
  });

  test("la rotation est transmise en sens inverse (repère ASS)", () => {
    const ass = buildTextsAss(project([makeText({ rotation: 15 })]), 1920, 1080);
    expect(ass).toContain("\\frz-15.00");
  });

  test("la machine à écrire produit des événements successifs qui finissent à la fin du texte", () => {
    const text = makeText({ text: "Une phrase assez longue", animation: { in: "typewriter", out: "fade", duration: 0.35 } });
    const events = textEvents(text, 1920, 1080);
    expect(events.length).toBeGreaterThan(5);
    expect(events[0].start).toBeCloseTo(text.start, 3);
    expect(events[events.length - 1].end).toBeCloseTo(text.start + text.duration, 3);
    // le texte affiché grandit
    const lengths = events.map((e) => e.text.length);
    for (let i = 1; i < lengths.length; i++) expect(lengths[i]).toBeGreaterThanOrEqual(lengths[i - 1]);
  });

  test("le surlignage mot par mot utilise le karaoké et la couleur dédiée", () => {
    const text = makeText({
      text: "un deux trois",
      style: { ...defaultTextStyle(), color: "#ffffff", highlightColor: "#ff0000" },
      animation: { in: "word-highlight", out: "none", duration: 0.35 },
    });
    const ass = buildTextsAss(project([text]), 1920, 1080);
    expect(ass).toContain("\\k");
    // PrimaryColour = surlignage (&H000000FF = rouge en BGR)
    expect(ass).toMatch(/Style: T0,.*,&H000000FF,/);
  });

  test("aucun texte → aucun fichier .ass (pas de rendu libass inutile)", () => {
    expect(buildTextsAss(project([]), 1920, 1080)).toBe("");
    expect(buildTextsAss(project([makeText({ text: "" })]), 1920, 1080)).toBe("");
  });

  test("la pastille de fond active le style « boîte »", () => {
    const style = { ...defaultTextStyle(), background: "#12081f", padding: 14 };
    const ass = buildTextsAss(project([makeText({ style })]), 1920, 1080);
    const styleLine = ass.split("\n").find((line) => line.startsWith("Style: T0"))!;
    // BorderStyle 3 = boîte pleine (contour utilisé comme marge intérieure).
    // Champs : 0 nom du style, puis Fontname…Angle (14), BorderStyle en 15.
    expect(styleLine.split(",")[15]).toBe("3");
  });
});
