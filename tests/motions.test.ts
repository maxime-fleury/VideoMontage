import { describe, expect, test } from "bun:test";
import { MOTIONS, MOTION_TEMPLATES, PLACEMENTS, motionExprs } from "../src/lib/motions";
// L'aperçu utilise exactement les mêmes gabarits : on vérifie que le remplissage
// côté serveur (ffmpeg) et côté navigateur donnent les mêmes nombres.
import { evalExpr, fillTemplate } from "../public/js/expr";

const BOX = { x: 0.6, y: 0.6, w: 0.34, h: 0.34 };
const DURATION = 4;
const AMOUNT = 0.5;

// On n'expose QUE `t` : comme ffmpeg, toute autre variable symbolique doit avoir
// été remplacée par un nombre (sinon le rendu échoue : « Undefined constant »).
const sample = (expression: string, t: number) => evalExpr(expression, { t });

describe("mouvements prédéfinis", () => {
  test("le catalogue expose des identifiants uniques et complets", () => {
    const ids = MOTIONS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const motion of MOTIONS) {
      expect(MOTION_TEMPLATES[motion.id]).toBeTruthy();
      for (const part of ["dx", "dy", "scale"]) {
        expect(typeof (MOTION_TEMPLATES[motion.id] as any)[part]).toBe("string");
      }
    }
  });

  test("serveur (ffmpeg) et aperçu (navigateur) produisent les mêmes valeurs", () => {
    for (const motion of MOTIONS) {
      const server = motionExprs({ preset: motion.id, amount: AMOUNT }, BOX, DURATION);
      const template = MOTION_TEMPLATES[motion.id];
      const values = { D: DURATION, A: AMOUNT, BW: BOX.w, BH: BOX.h, P: 0 };
      for (const t of [0, 0.25, 1, 2, 3.9, DURATION]) {
        const clientValues = { ...values, P: Math.max(0, Math.min(1, t / DURATION)) };
        for (const part of ["dx", "dy", "scale"] as const) {
          const client = evalExpr(fillTemplate(template[part], clientValues), { t });
          const fromServer = sample(server[part], t);
          expect(Math.abs(fromServer - client)).toBeLessThan(1e-9);
          expect(Number.isFinite(fromServer)).toBe(true);
        }
      }
    }
  });

  test("aucun mouvement ne reste figé (sauf les fixes) et l'échelle reste positive", () => {
    for (const motion of MOTIONS) {
      const server = motionExprs({ preset: motion.id, amount: 1 }, BOX, DURATION);
      for (const t of [0, 0.5, 1, 2, 3, DURATION]) {
        const scale = sample(server.scale, t);
        expect(scale).toBeGreaterThan(0.1);
        expect(scale).toBeLessThan(4);
      }
      if (["none", "pip-static"].includes(motion.id)) {
        expect(sample(server.dx, 0) + sample(server.dy, 0)).toBe(0);
        expect(sample(server.scale, 2)).toBe(1);
        continue;
      }
      const moved =
        Math.abs(sample(server.dx, 0) - sample(server.dx, DURATION)) > 1e-6 ||
        Math.abs(sample(server.dy, 0) - sample(server.dy, DURATION)) > 1e-6 ||
        Math.abs(sample(server.scale, 0) - sample(server.scale, DURATION)) > 1e-6;
      expect(moved).toBe(true);
    }
  });

  test("la dérive horizontale est centrée au milieu du clip", () => {
    const server = motionExprs({ preset: "drift-left", amount: 1 }, BOX, DURATION);
    const start = sample(server.dx, 0);
    const middle = sample(server.dx, DURATION / 2);
    const end = sample(server.dx, DURATION);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeLessThan(0);
    expect(Math.abs(middle)).toBeLessThan(1e-6);
    expect(Math.abs(start + end)).toBeLessThan(1e-6);
  });

  test("les agencements restent dans le cadre et ont un mouvement connu", () => {
    for (const placement of PLACEMENTS) {
      expect(placement.box.x).toBeGreaterThanOrEqual(0);
      expect(placement.box.y).toBeGreaterThanOrEqual(0);
      expect(placement.box.x + placement.box.w).toBeLessThanOrEqual(1.0001);
      expect(placement.box.y + placement.box.h).toBeLessThanOrEqual(1.0001);
      expect(MOTION_TEMPLATES[placement.motion]).toBeTruthy();
    }
  });

  test("les expressions ffmpeg n'utilisent que la variable de temps `t`", () => {
    const functions = /\b(min|max|ceil|floor|abs|round|sin|cos|sqrt|if)\b/g;
    for (const motion of MOTIONS) {
      const expressions = motionExprs({ preset: motion.id, amount: AMOUNT }, BOX, DURATION);
      for (const expression of [expressions.dx, expressions.dy, expressions.scale]) {
        expect(expression).not.toContain("undefined");
        // Aucun jeton symbolique ne doit survivre au remplissage (D, P, A, BW…).
        const identifiers = [...new Set(expression.replace(functions, "").match(/[A-Za-z]+/g) || [])];
        // Seule variable tolérée : le temps `t` fourni par ffmpeg (ou aucune).
        expect(identifiers.filter((name) => name !== "t")).toEqual([]);
      }
    }
  });
});
