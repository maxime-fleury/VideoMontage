import { S, on, emit } from "./state.js";
import { $, api, toast } from "./api.js";

const LIMIT = 40;
let baseline = null;
let undoStack = [];
let redoStack = [];
let applying = false;
let currentProjectId = null;

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

/**
 * État restaurable d'un projet. On ne touche jamais aux sources ni aux fichiers:
 * annuler l'ajout d'une illustration laisse simplement l'image dans la médiathèque.
 */
function snapshot(project) {
  return {
    name: project.name,
    videoTrack: clone(project.videoTrack) || [],
    audioTracks: clone(project.audioTracks) || [],
    subtitles: clone(project.subtitles),
    transcript: clone(project.transcript) ?? null,
    output: clone(project.output),
    voice: project.voice?.sourceId ? { sourceId: project.voice.sourceId, edits: clone(project.voice.edits) } : undefined,
  };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function updateButtons() {
  const undo = $("#btnUndo");
  const redo = $("#btnRedo");
  if (undo) {
    undo.disabled = !undoStack.length;
    undo.title = undoStack.length ? `Annuler (${undoStack.length}) — Ctrl+Z` : "Rien à annuler";
  }
  if (redo) {
    redo.disabled = !redoStack.length;
    redo.title = redoStack.length ? `Rétablir (${redoStack.length}) — Ctrl+Shift+Z` : "Rien à rétablir";
  }
}

/** Mémorise un point d'annulation (appelé à chaque modification persistée). */
function capture() {
  if (applying || !S.project) return;
  const current = snapshot(S.project);
  if (!baseline) {
    baseline = current;
    return;
  }
  if (same(current, baseline)) return;
  undoStack.push({ before: baseline, after: current });
  if (undoStack.length > LIMIT) undoStack.shift();
  redoStack = [];
  baseline = current;
  updateButtons();
}

async function apply(target, label) {
  if (!target || !S.project) return;
  const body = { ...target };
  if (!body.voice) delete body.voice;
  else if (same(body.voice.edits, S.project.voice?.edits)) delete body.voice;
  if (body.transcript === undefined) delete body.transcript;

  applying = true;
  try {
    const { project } = await api(`/api/projects/${S.project.id}/update`, { method: "POST", body });
    S.project = project;
    emit("project-external", project);
    emit("render");
    if (label) toast(label, "info", 2000);
  } catch (e) {
    toast(`Impossible de revenir en arrière : ${e.message}`, "error");
  } finally {
    applying = false;
  }
  baseline = snapshot(S.project);
  updateButtons();
}

export async function undo() {
  const entry = undoStack.pop();
  if (!entry) return toast("Rien à annuler", "info", 1800);
  redoStack.push(entry);
  await apply(entry.before, "Annulé");
}

export async function redo() {
  const entry = redoStack.pop();
  if (!entry) return toast("Rien à rétablir", "info", 1800);
  undoStack.push(entry);
  await apply(entry.after, "Rétabli");
}

export function initHistory() {
  $("#btnUndo")?.addEventListener("click", undo);
  $("#btnRedo")?.addEventListener("click", redo);

  on("project", () => {
    const id = S.project?.id || null;
    // le même projet est réaffiché plusieurs fois (setProject via project-external) :
    // on ne remet l'historique à zéro que lorsqu'on change réellement de projet.
    if (id === currentProjectId) {
      if (!baseline && S.project) baseline = snapshot(S.project);
      updateButtons();
      return;
    }
    currentProjectId = id;
    baseline = S.project ? snapshot(S.project) : null;
    undoStack = [];
    redoStack = [];
    updateButtons();
  });
  on("persist", capture);
  on("project-external", capture);

  window.addEventListener("keydown", (e) => {
    const tag = e.target?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (!(e.ctrlKey || e.metaKey)) return;
    const key = e.key.toLowerCase();
    if (key === "z" && !e.shiftKey) {
      e.preventDefault();
      undo();
    } else if ((key === "z" && e.shiftKey) || key === "y") {
      e.preventDefault();
      redo();
    }
  });

  if (S.project) baseline = snapshot(S.project);
  updateButtons();
}

export function historyState() {
  return { undo: undoStack.length, redo: redoStack.length };
}
