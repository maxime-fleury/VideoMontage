import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Test de bout en bout du couple serveur + front :
 * - le serveur démarre sur un dossier de données isolé (jamais le vrai projet) ;
 * - les modules du navigateur sont réellement servis et leurs imports existent ;
 * - les limites du modèle (3 calques) sont bien appliquées par l'API.
 */

const PORT = 39000 + Math.floor(Math.random() * 500);
const DATA_DIR = path.join(os.tmpdir(), `montagevideo-test-${Date.now()}`);
const BASE = `http://localhost:${PORT}`;

let server: ReturnType<typeof Bun.spawn> | null = null;
let serverLog = "";

async function waitForServer(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/setup/status`);
      if (res.ok) return;
    } catch {
      // pas encore prêt
    }
    await Bun.sleep(150);
  }
  throw new Error(`Le serveur n'a pas démarré.\n${serverLog.slice(-2000)}`);
}

beforeAll(async () => {
  await fs.mkdir(DATA_DIR, { recursive: true });
  server = Bun.spawn([process.execPath, "run", "src/index.ts"], {
    env: {
      ...process.env,
      MONTAGE_DATA_DIR: DATA_DIR,
      MONTAGE_PORT: String(PORT),
      MONTAGE_SKIP_AUTOFONTS: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  // draine la sortie du serveur (sinon le tube finit par bloquer) et la garde pour les erreurs
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      serverLog += decoder.decode(value, { stream: true });
      if (serverLog.length > 20000) serverLog = serverLog.slice(-10000);
    }
  };
  void drain(server.stdout).catch(() => {});
  void drain(server.stderr).catch(() => {});
  await waitForServer();
}, 30000);

afterAll(async () => {
  server?.kill();
  await fs.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
});

describe("interface servie", () => {
  test("la page d'accueil est servie avec ses assets", async () => {
    const res = await fetch(`${BASE}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-panel="preview"');
    expect(html).toContain('id="stage"');
    expect(html).toContain("js/app.js");
    // le bouton d'annulation de tâche doit exister dans la barre de progression
    expect(html).toContain('id="jobCancel"');

    const css = await fetch(`${BASE}/style.css`);
    expect(css.status).toBe(200);
  });

  test("tous les modules du navigateur se chargent (imports résolus)", async () => {
    const seen = new Set<string>();
    const queue = ["/js/app.js"];
    const missing: string[] = [];
    while (queue.length) {
      const url = queue.shift()!;
      if (seen.has(url)) continue;
      seen.add(url);
      const res = await fetch(`${BASE}${url}`);
      if (!res.ok) {
        missing.push(url);
        continue;
      }
      const source = await res.text();
      for (const match of source.matchAll(/from\s+"(\.[^"]+)"/g)) {
        const target = new URL(match[1], `${BASE}${url}`).pathname;
        if (!seen.has(target)) queue.push(target);
      }
    }
    expect(missing).toEqual([]);
    // le front est découpé en plusieurs modules : on en teste plus qu'un
    expect(seen.size).toBeGreaterThan(15);
  });

  test("le catalogue des mouvements est disponible pour l'aperçu", async () => {
    const res = await fetch(`${BASE}/api/motions`);
    expect(res.status).toBe(200);
    const catalog = await res.json();
    expect(Array.isArray(catalog.motions)).toBe(true);
    expect(catalog.templates["drift-left"].dx).toBeTruthy();
  });
});

describe("routes de projet", () => {
  const create = async (name: string) => {
    const res = await fetch(`${BASE}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    expect(res.status).toBe(200);
    return (await res.json()).project;
  };

  const update = (id: string, body: unknown) =>
    fetch(`${BASE}/api/projects/${id}/update`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  test("la limite de 3 calques est refusée par l'API et acceptée en dessous", async () => {
    const project = await create("Test calques");
    const layer = (name: string) => ({ name, clips: [] });

    const tooMany = await update(project.id, { overlayLayers: [layer("a"), layer("b"), layer("c"), layer("d")] });
    expect(tooMany.status).toBe(400);
    expect((await tooMany.json()).error).toContain("3 pistes");

    const ok = await update(project.id, { overlayLayers: [layer("a"), layer("b"), layer("c")] });
    expect(ok.status).toBe(200);
    expect((await ok.json()).project.overlayLayers).toHaveLength(3);

    await fetch(`${BASE}/api/projects/${project.id}`, { method: "DELETE" });
  });

  test("les calques et textes reçus sont normalisés et persistés", async () => {
    const project = await create("Test normalisation");
    const res = await update(project.id, {
      overlayLayers: [{ name: "Calque", clips: [{ sourceId: "src_x", duration: 0, box: { x: 5, y: -9, w: 0.2, h: 0.3 } }] }],
      texts: [{ text: "Bonjour", box: { x: 0.1, y: 0.1, w: 0.8, h: 0.2 } }],
    });
    expect(res.status).toBe(200);
    const saved = (await res.json()).project;
    expect(saved.overlayLayers[0].clips[0].duration).toBe(3);
    expect(saved.overlayLayers[0].clips[0].box.x).toBe(2);
    expect(saved.texts[0].text).toBe("Bonjour");
    expect(saved.texts[0].style.font).toBe("Outfit");

    // relecture : ce qui a été normalisé est bien ce qui est stocké
    const again = await (await fetch(`${BASE}/api/projects/${project.id}`)).json();
    expect(again.project.texts[0].id).toBe(saved.texts[0].id);
    await fetch(`${BASE}/api/projects/${project.id}`, { method: "DELETE" });
  });

  test("les routes inconnues répondent proprement", async () => {
    expect((await fetch(`${BASE}/api/nawak`)).status).toBe(404);
    expect((await fetch(`${BASE}/api/projects/prj_inconnu`)).status).toBe(404);
    const cancel = await fetch(`${BASE}/api/jobs/job_inconnu`, { method: "POST" });
    expect(cancel.status).toBe(404);
    const cancelJob = await fetch(`${BASE}/api/jobs/job_inconnu/cancel`, { method: "POST" });
    expect(cancelJob.status).toBe(409);
  });
});
