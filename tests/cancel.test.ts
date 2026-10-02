import { describe, expect, test } from "bun:test";
import { cancelJob, createJob, finishJob, getJob, heavyQueueSize, isCancelled, runHeavyJob } from "../src/lib/jobs";
import { RunCancelled, run } from "../src/lib/util";

/** Processus long : sert de faux ffmpeg/whisper. */
const SLEEP_CMD = [process.execPath, "-e", "await Bun.sleep(30000)"];

describe("annulation des tâches", () => {
  test("annuler tue le processus en cours et rejette la tâche", async () => {
    const job = createJob("export", "Rendu de test");
    let started = false;
    const task = runHeavyJob(job.id, async () => {
      started = true;
      await run(SLEEP_CMD);
      return "terminé";
    });

    // laisse le temps au processus de démarrer puis annule
    await Bun.sleep(400);
    expect(started).toBe(true);
    const before = Date.now();
    expect(cancelJob(job.id)).toBe(true);

    await expect(task).rejects.toThrow(RunCancelled);
    // le processus est tué tout de suite : pas d'attente de la fin des 30 s
    expect(Date.now() - before).toBeLessThan(5000);
    expect(getJob(job.id)!.status).toBe("cancelled");
    expect(isCancelled(job.id)).toBe(true);
    // une seconde annulation ne fait rien
    expect(cancelJob(job.id)).toBe(false);
  });

  test("la commande suivante d'une tâche annulée échoue immédiatement", async () => {
    const job = createJob("export", "Deux commandes");
    const task = (async () => {
      await runHeavyJob(job.id, async () => {
        await run(SLEEP_CMD);
        // jamais atteint : le processus ci-dessus est tué à l'annulation
        await run([process.execPath, "-e", "console.log('ne doit pas tourner')"]);
      });
    })();
    await Bun.sleep(400);
    cancelJob(job.id);
    await expect(task).rejects.toThrow(RunCancelled);
    expect(getJob(job.id)!.status).toBe("cancelled");
  });

  test("un seul travail lourd à la fois : le second attend son tour", async () => {
    const order: string[] = [];
    const first = createJob("export", "Premier");
    const second = createJob("export", "Second");

    const start = async (jobId: string, label: string, ms: number) => {
      await runHeavyJob(jobId, async () => {
        order.push(`${label}:début`);
        await Bun.sleep(ms);
        order.push(`${label}:fin`);
      });
      finishJob(jobId, { ok: true }, "fini");
    };

    const a = start(first.id, "a", 300);
    await Bun.sleep(50);
    const b = start(second.id, "b", 10);
    await Promise.all([a, b]);

    expect(order).toEqual(["a:début", "a:fin", "b:début", "b:fin"]);
    expect(getJob(first.id)!.status).toBe("done");
    expect(getJob(second.id)!.status).toBe("done");
  });

  test("une tâche qui détient la place peut redécouper son travail (réentrant)", async () => {
    const job = createJob("auto-full", "Montage complet");
    const done: string[] = [];
    await runHeavyJob(job.id, async () => {
      done.push("étape 1");
      // sans réentrance, cet appel attendrait une place que la tâche détient déjà
      await runHeavyJob(job.id, async () => {
        done.push("étape 2");
        await runHeavyJob(job.id, async () => {
          done.push("étape 3");
        });
      });
      done.push("fin");
    });
    expect(done).toEqual(["étape 1", "étape 2", "étape 3", "fin"]);
    expect(heavyQueueSize()).toBe(0);
  });

  test("annuler une tâche qui attend son tour ne la démarre jamais", async () => {
    const running = createJob("export", "En cours");
    const queued = createJob("export", "En attente");
    let queuedStarted = false;

    const current = runHeavyJob(running.id, () => Bun.sleep(700));
    await Bun.sleep(50);
    const waiting = runHeavyJob(queued.id, async () => {
      queuedStarted = true;
    });
    await Bun.sleep(50);
    expect(cancelJob(queued.id)).toBe(true);
    await expect(waiting).rejects.toThrow(RunCancelled);

    await current;
    finishJob(running.id, { ok: true }, "fini");
    await Bun.sleep(50);
    expect(queuedStarted).toBe(false);
    expect(getJob(queued.id)!.status).toBe("cancelled");
  });
});
