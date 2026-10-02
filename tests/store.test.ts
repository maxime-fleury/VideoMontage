import { describe, expect, test } from "bun:test";
import {
  defaultBox,
  defaultEffect,
  defaultMotion,
  defaultTextAnimation,
  defaultTextBox,
  defaultTextStyle,
  type VoiceEdits,
} from "../src/lib/store";
import { buildSegments, subtractRanges, mergeRanges, mapOutToSource } from "../src/lib/ffmpeg";

const edits = (patch: Partial<VoiceEdits> = {}): VoiceEdits => ({
  cuts: [],
  ffwd: [],
  ffwdFactor: 100,
  denoise: { mode: "none", reduction: 12 },
  normalize: false,
  ...patch,
});

describe("valeurs par défaut du projet", () => {
  test("un texte libre arrive avec un style complet et lisible", () => {
    const style = defaultTextStyle();
    for (const key of ["font", "color", "outlineColor", "highlightColor", "align"] as const) {
      expect(typeof style[key]).toBe("string");
      expect(String(style[key]).length).toBeGreaterThan(0);
    }
    expect(style.size).toBeGreaterThan(0.02);
    expect(style.size).toBeLessThan(0.3);
    const box = defaultTextBox();
    expect(box.x + box.w).toBeLessThanOrEqual(1);
    expect(box.y + box.h).toBeLessThanOrEqual(1);
    expect(["fade", "pop", "slide-up", "typewriter", "word-highlight"]).toContain(defaultTextAnimation().in);
  });

  test("une incrustation démarre en PiP avec un mouvement prédéfini", () => {
    const box = defaultBox();
    expect(box.x).toBeGreaterThan(0.5);
    expect(box.y).toBeGreaterThan(0.5);
    expect(defaultMotion().preset).toBe("pip-corner");
    expect(defaultEffect().transition.type).toBe("fade-black");
  });
});

describe("segments de la piste voix", () => {
  test("chaque silence de la liste est réellement accéléré (régression 1e-4)", () => {
    // Bornes volontairement « laides » : c'est ce qui faisait échouer la comparaison
    // avant l'arrondi commun (seuls 13 silences sur 86 étaient accélérés).
    const ffwd = mergeRanges([
      { start: 1.23456, end: 2.34567 },
      { start: 3.00004, end: 4.00009 },
      { start: 5.99999, end: 7.00001 },
    ]);
    const segments = buildSegments(edits({ ffwd }), 10);
    for (const range of ffwd) {
      const length = range.end - range.start;
      const accelerated = segments
        .filter((seg) => seg.srcStart >= range.start - 1e-4 && seg.srcEnd <= range.end + 1e-4)
        .reduce((acc, seg) => acc + (seg.srcEnd - seg.srcStart), 0);
      expect(Math.abs(accelerated - length)).toBeLessThan(0.002);
      for (const seg of segments.filter((s) => s.srcStart >= range.start - 1e-4 && s.srcEnd <= range.end + 1e-4)) {
        expect(seg.tempo).toBe(100);
      }
    }
  });

  test("une coupe gagne sur une accélération qui la chevauche", () => {
    const segments = buildSegments(edits({ ffwd: [{ start: 1, end: 5 }], cuts: [{ start: 2, end: 3 }] }), 6);
    const cut = segments.find((seg) => seg.srcStart === 2 && seg.srcEnd === 3);
    expect(cut).toBeUndefined();
    const outside = segments.filter((seg) => seg.srcStart >= 1 && seg.srcEnd <= 2);
    expect(outside.length).toBeGreaterThan(0);
    for (const seg of outside) expect(seg.tempo).toBe(100);
  });

  test("la durée de sortie est cohérente : normale + accélérée", () => {
    const segments = buildSegments(edits({ ffwd: [{ start: 2, end: 4 }] }), 6);
    const total = segments.reduce((acc, seg) => acc + (seg.srcEnd - seg.srcStart) / seg.tempo, 0);
    const expected = 4 + 2 / 100;
    expect(Math.abs(total - expected)).toBeLessThan(1e-6);
    // les segments se suivent sans trou dans la timeline
    for (let i = 1; i < segments.length; i++) {
      expect(Math.abs(segments[i].outStart - segments[i - 1].outEnd)).toBeLessThan(1e-9);
    }
  });

  test("sans édition, le montage suit la source à l'identique", () => {
    const segments = buildSegments(edits(), 12.5);
    expect(segments).toHaveLength(1);
    expect(segments[0].tempo).toBe(1);
    expect(segments[0].srcEnd).toBeCloseTo(12.5, 6);
    expect(segments[0].outEnd).toBeCloseTo(12.5, 6);
  });

  test("subtractRanges et mapOutToSource restent cohérents", () => {
    expect(subtractRanges([{ start: 0, end: 10 }], [{ start: 2, end: 4 }])).toEqual([
      { start: 0, end: 2 },
      { start: 4, end: 10 },
    ]);
    const segments = buildSegments(edits({ ffwd: [{ start: 0, end: 10 }] }), 10);
    // 1 s de timeline correspond à 100 s de source quand tout est accéléré ×100
    const mapped = mapOutToSource(segments, 0, 0.05);
    expect(mapped[0].start).toBeCloseTo(0, 3);
    expect(mapped[0].end).toBeCloseTo(5, 2);
  });
});
