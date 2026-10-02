import { describe, expect, test } from "bun:test";
import { createJob, failJob, finishJob, getJob, resumeJob, setCheckpoint, subscribeJob, updateJob } from "../src/lib/jobs";

describe("tâches avec points de contrôle", () => {
  test("un point de contrôle met la tâche en attente et la reprise débloque l'attente", async () => {
    const job = createJob("test", "Test");
    const seen: string[] = [];
    const unsubscribe = subscribeJob(job.id, (state) => seen.push(state.status));

    const waiting = setCheckpoint(job.id, { id: "silences", label: "Silences", payload: { silences: 3 } }, 0.2);
    expect(getJob(job.id)!.status).toBe("waiting");
    expect(getJob(job.id)!.checkpoint?.id).toBe("silences");
    expect(getJob(job.id)!.progress).toBeCloseTo(0.2, 6);

    expect(resumeJob(job.id, { adjust: { factor: 10 } })).toBe(true);
    const answer = (await waiting) as { adjust: { factor: number } };
    expect(answer.adjust.factor).toBe(10);
    expect(getJob(job.id)!.status).toBe("running");
    expect(getJob(job.id)!.checkpoint).toBe(null);

    finishJob(job.id, { ok: true }, "Fini");
    expect(getJob(job.id)!.status).toBe("done");
    expect(getJob(job.id)!.finishedAt).toBeGreaterThan(0);
    expect(seen).toContain("waiting");
    unsubscribe();
  });

  test("une reprise sans attente en cours est refusée", () => {
    const job = createJob("test", "Test 2");
    expect(resumeJob(job.id, {})).toBe(false);
  });

  test("un échec pendant l'attente libère la tâche", async () => {
    const job = createJob("test", "Test 3");
    const waiting = setCheckpoint(job.id, { id: "export", label: "Export" });
    failJob(job.id, "boum");
    const answer = (await waiting) as { cancelled?: boolean };
    expect(answer.cancelled).toBe(true);
    expect(getJob(job.id)!.status).toBe("error");
    expect(getJob(job.id)!.error).toBe("boum");
    expect(resumeJob(job.id, {})).toBe(false);
  });

  test("une tâche en attente n'est pas terminée et garde son journal", () => {
    const job = createJob("test", "Test 4");
    updateJob(job.id, { log: "ligne 1" });
    setCheckpoint(job.id, { id: "keywords", label: "Mots-clés" });
    const state = getJob(job.id)!;
    expect(state.finishedAt).toBeUndefined();
    expect(state.logs).toContain("ligne 1");
  });
});
