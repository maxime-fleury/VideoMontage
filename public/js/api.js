export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "html") node.innerHTML = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else if (key === "style" && typeof value === "object") Object.assign(node.style, value);
    else if (value !== undefined && value !== null && value !== false) node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

export async function api(path, { method = "GET", body, form } = {}) {
  const options = { method };
  if (form) options.body = form;
  else if (body !== undefined) {
    options.headers = { "content-type": "application/json" };
    options.body = JSON.stringify(body);
  }
  const res = await fetch(path, options);
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text.slice(0, 300) };
  }
  if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
  return data;
}

export function toast(message, kind = "info", timeout = 5200) {
  const host = $("#toasts");
  const node = el("div", { class: `toast ${kind}`, text: message });
  host.append(node);
  setTimeout(() => node.remove(), timeout);
  return node;
}

export function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

export function newId(prefix = "id") {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Effets par défaut d'un clip vidéo (doit rester aligné avec le serveur). */
export function defaultClipEffect() {
  return {
    fadeIn: 0.4,
    fadeOut: 0.4,
    kenBurns: false,
    zoomFrom: 1,
    zoomTo: 1.12,
    transition: { type: "fade-black", duration: 0.5 },
  };
}

export function fmtTime(t) {
  if (!isFinite(t)) t = 0;
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

export function fmtBytes(bytes) {
  const n = Math.max(0, Number(bytes) || 0);
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} Ko`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} Mo`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} Go`;
}

export function fmtDuration(t) {
  const m = Math.floor(t / 60);
  const s = Math.round(t % 60);
  return `${m} min ${String(s).padStart(2, "0")} s`;
}

/** Tâche suivie en ce moment : cible du bouton « Annuler ». */
let watchedJob = null;
let cancelWired = false;
const watchHandlers = new Set();

/** Prévient quand une tâche commence ou finit d'être suivie (boutons d'annulation). */
export function onJobWatched(fn) {
  watchHandlers.add(fn);
  fn(!!watchedJob);
  return () => watchHandlers.delete(fn);
}

/**
 * Bouton « Annuler » clé en main : visible seulement pendant qu'une tâche tourne.
 * Utilisé dans les modales (rendu, montage auto) en plus de la barre du haut.
 */
export function cancelJobButton(label = "⏹ Annuler la tâche") {
  const btn = el("button", { class: "ghost", text: label, hidden: true });
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    await cancelWatchedJob();
    btn.disabled = false;
  });
  onJobWatched((watched) => {
    btn.hidden = !watched;
    btn.disabled = false;
  });
  return btn;
}

function syncCancelButton() {
  const btn = document.getElementById("jobCancel");
  if (btn) {
    btn.hidden = !watchedJob;
    if (!cancelWired) {
      cancelWired = true;
      btn.addEventListener("click", cancelWatchedJob);
    }
  }
  for (const fn of watchHandlers) {
    try {
      fn(!!watchedJob);
    } catch {}
  }
}

/** Interrompt la tâche en cours (tue les processus ffmpeg/whisper côté serveur). */
export async function cancelWatchedJob() {
  const id = watchedJob;
  if (!id) return;
  const btn = document.getElementById("jobCancel");
  if (btn) btn.disabled = true;
  try {
    await api(`/api/jobs/${id}/cancel`, { method: "POST" });
    toast("Tâche annulée", "info");
  } catch (e) {
    toast(`Annulation impossible : ${e.message}`, "error");
  } finally {
    if (btn) btn.disabled = false;
  }
}

/** Suit une tâche serveur via SSE avec repli sur du polling. */
export function watchJob(jobId, onUpdate) {
  let closed = false;
  let pollTimer = null;
  let source = null;
  watchedJob = jobId;
  syncCancelButton();

  const stop = () => {
    closed = true;
    try {
      source?.close();
    } catch {}
    if (pollTimer) clearTimeout(pollTimer);
    if (watchedJob === jobId) {
      watchedJob = null;
      syncCancelButton();
    }
  };

  const handle = (raw) => {
    if (closed) return;
    // Une tâche annulée est présentée comme un échec aux écrans existants : les
    // boutons se réactivent et aucun résultat partiel n'est proposé. Le drapeau
    // `cancelled` permet un message plus juste là où c'est utile.
    const job =
      raw.status === "cancelled" ? { ...raw, status: "error", error: "Tâche annulée", cancelled: true } : raw;
    onUpdate(job);
    // « waiting » = pause sur un point de contrôle : le suivi continue, la tâche
    // reprendra au clic sur Continuer (resumeJob).
    if (job.status !== "running" && job.status !== "waiting") stop();
  };

  const startPolling = () => {
    const tick = async () => {
      if (closed) return;
      try {
        const job = await api(`/api/jobs/${jobId}`);
        handle(job);
      } catch (e) {
        toast(`Suivi de tâche perdu : ${e.message}`, "error");
        stop();
        return;
      }
      if (!closed) pollTimer = setTimeout(tick, 900);
    };
    tick();
  };

  try {
    source = new EventSource(`/api/jobs/${jobId}/events`);
    source.onmessage = (event) => {
      try {
        handle(JSON.parse(event.data));
      } catch {}
    };
    source.onerror = () => {
      if (closed) return;
      try {
        source.close();
      } catch {}
      startPolling();
    };
  } catch {
    startPolling();
  }
  return stop;
}

/** Reprend une tâche arrêtée sur un point de contrôle. */
export async function resumeJob(jobId, data, action = "resume") {
  return api(`/api/jobs/${jobId}/resume`, { method: "POST", body: { data, action } });
}

/** Dialogue modal simple. render(close) renvoie le contenu. */
export function openModal(render) {
  const backdrop = $("#modal");
  const box = $("#modalBox");
  box.innerHTML = "";
  backdrop.hidden = false;
  const close = () => {
    backdrop.hidden = true;
    box.innerHTML = "";
  };
  box.append(render(close));
  backdrop.onclick = (e) => {
    if (e.target === backdrop) close();
  };
  document.addEventListener("keydown", function esc(e) {
    if (e.key === "Escape") {
      close();
      document.removeEventListener("keydown", esc);
    }
  });
  return close;
}

export function busy(label, progress = 0, detail = "") {
  const status = $("#jobStatus");
  if (!status) return;
  status.hidden = false;
  syncCancelButton();
  const text = $("#jobText");
  if (text) text.textContent = `${label}${detail ? ` — ${detail}` : ""}`;
  const bar = $("#jobBar");
  if (bar) bar.style.width = `${Math.round(progress * 100)}%`;
}

export function clearBusy() {
  const status = $("#jobStatus");
  if (status) status.hidden = true;
  syncCancelButton();
}
