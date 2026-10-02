import { describe, expect, test } from "bun:test";
import { buildAutoSlots, cleanWordText, pickKeyword, scoreWord } from "../src/lib/keywords";
import type { Project } from "../src/lib/store";

/** Construit une fausse transcription mot à mot (0,4 s par mot). */
function projectWithText(text: string): Project {
  const words = text.split(/\s+/).filter(Boolean);
  let time = 0;
  const timed = words.map((w) => {
    const word = { w, s: time, e: time + 0.38 };
    time += 0.4;
    return word;
  });
  return {
    transcript: {
      language: "fr",
      hash: "test",
      createdAt: Date.now(),
      segments: [{ id: "seg_1", start: 0, end: time, text, words: timed }],
    },
  } as unknown as Project;
}

describe("moteur de mots-clés", () => {
  test("les élisions et la ponctuation sont nettoyées", () => {
    expect(cleanWordText("l'intérieur,")).toBe("intérieur");
    expect(cleanWordText("d'avoir")).toBe("avoir");
    expect(cleanWordText("« Grimoire »")).toBe("Grimoire");
    // apostrophe typographique (Whisper) : l'élision doit être vue
    expect(cleanWordText("l’intérieur")).toBe("intérieur");
    expect(cleanWordText("jusqu’à")).toBe("à");
    expect(cleanWordText("...")).toBe("");
  });

  test("un nom précédé d'un déterminant est mieux noté qu'un verbe précédé d'un pronom", () => {
    const freq = new Map([["grimoire", 2]]);
    const noun = scoreWord("grimoire", "grimoire", freq, { prev: "le", next: "", isSentenceStart: false });
    const verb = scoreWord("grimoire", "grimoire", freq, { prev: "je", next: "", isSentenceStart: false });
    expect(noun).toBeGreaterThan(verb);
    // un mot propre en cours de phrase est un bon candidat
    expect(scoreWord("Poudlard", "poudlard", freq, { prev: "à", next: "", isSentenceStart: false })).toBeGreaterThan(3.5);
    // un adverbe en -ment ne l'est pas
    expect(scoreWord("rapidement", "rapidement", freq, { prev: "il", next: "", isSentenceStart: false })).toBeLessThan(0);
  });

  test("les créneaux retiennent les noms concrets et écartent les mots vides", () => {
    const project = projectWithText(
      "Le vieux grimoire noir reposait sur la table. Il contenait un secret magnifique pour toujours et encore."
    );
    const slots = buildAutoSlots(project, 1.5);
    expect(slots.length).toBeGreaterThan(0);
    const keywords = slots.flatMap((slot) => slot.keywords);
    expect(keywords.join(" | ").toLowerCase()).toContain("grimoire");
    expect(keywords.join(" | ").toLowerCase()).toContain("table");
    // aucun mot outil ni adverbe ne doit passer le seuil
    for (const word of ["toujours", "encore", "pour", "contenait", "reposait"]) {
      expect(keywords.map((k) => k.toLowerCase())).not.toContain(word);
    }
    for (const slot of slots) {
      expect(slot.top).toBe(slot.keywords[0]);
      expect(slot.scores[0]).toBeGreaterThanOrEqual(3.5);
      expect(slot.end).toBeGreaterThan(slot.start);
      expect(slot.keywords.length).toBeLessThanOrEqual(5);
    }
  });

  test("sans transcription, aucun créneau n'est inventé", () => {
    expect(buildAutoSlots({ sources: [], videoTrack: [] } as unknown as Project, 2)).toEqual([]);
  });

  test("un mot-clé déjà utilisé est écarté au profit de l'alternative", () => {
    const slot = { start: 0, end: 3, keywords: ["grimoire noir", "table"], scores: [5, 4], top: "grimoire noir" };
    expect(pickKeyword(slot, new Set())).toBe("grimoire noir");
    expect(pickKeyword(slot, new Set(["grimoire noir"]))).toBe("table");
    // « grimoire » utilisé ⇒ « grimoire noir » est écarté aussi (même tête)
    expect(pickKeyword(slot, new Set(["grimoire"]))).toBe("table");
    // tout est utilisé : on retombe sur le meilleur choix plutôt que rien
    expect(pickKeyword(slot, new Set(["grimoire noir", "table"]))).toBe("grimoire noir");
  });
});
