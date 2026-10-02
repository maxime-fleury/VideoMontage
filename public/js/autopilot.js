import { S, emit, on, adoptProject } from "./state.js";
import { $, el, api, toast, watchJob, resumeJob, clamp, fmtTime, cancelJobButton } from "./api.js";
import { panel, slider, toggle } from "./controls.js";
import { showPanel } from "./layout.js";

/**
 * Montage automatique complet : une seule tâche qui enchaîne silences →
 * transcription → mots-clés → illustrations → sous-titres → export, avec des
 * points de contrôle où l'on valide (ou ajuste) avant de continuer.
 */

const STEPS = [
  { id: "silences", label: "Nettoyage des silences", icon: "⏩" },
  { id: "transcription", label: "Transcription Whisper", icon: "🗣️" },
  { id: "keywords", label: "Mots-clés", icon: "🔑" },
  { id: "illustrations", label: "Illustrations", icon: "🖼️" },
  { id: "subtitles", label: "Sous-titres", icon: "💬" },
  { id: "export", label: "Export", icon: "🎬" },
];

let stopWatch = null;
let running = false;

let resumeChecked = false;

/**
 * Suit à nouveau un montage complet resté en cours (typiquement après un
 * rechargement de la page) : sans cela le montage attendrait une validation que
 * personne ne pourrait donner, et l'annulation ne serait plus accessible.
 */
function checkPendingJob() {
  if (resumeChecked || running) return;
  const pending = S.project?.auto?.jobId;
  if (!pending) return;
  resumeChecked = true;
  api(`/api/jobs/${pending}`)
    .then((job) => {
      if (job && (job.status === "waiting" || job.status === "running")) track(pending);
    })
    .catch(() => {});
}

export function initAutopilot() {
  renderAutoPanel();
  on("project", () => {
    renderAutoPanel();
    checkPendingJob();
  });
  on("project-external", renderAutoPanel);
  on("auto-job", ({ jobId }) => track(jobId));
  on("auto-open", () => {
    showPanel("auto", true);
    const card = $('.card[data-panel="auto"]');
    card?.scrollIntoView({ behavior: "smooth", block: "center" });
    card?.classList.add("flash");
    setTimeout(() => card?.classList.remove("flash"), 1200);
  });
  checkPendingJob();
}

function renderAutoPanel() {
  const host = $("#autoPanel");
  if (!host) return;
  host.innerHTML = "";
  const auto = S.project?.auto;
  if (running) return; // la carte de suivi est déjà affichée

  if (auto?.report?.length) {
    host.append(
      el("div", { class: "notice" }, [
        el("span", { text: "Dernier montage complet : clique pour voir le journal." }),
      ])
    );
  }

  // --- réglages ---
  const denoise = toggle("Débruitage automatique", false, () => {});
  const minSilence = slider("Durée mini d'un silence", { min: 0.15, max: 1.5, step: 0.05, value: 0.35, unit: " s" });
  const factor = slider("Accélération des silences", { min: 2, max: 100, step: 1, value: 100, unit: "×" });
  const maxClips = slider("Nombre max d'illustrations", { min: 4, max: 80, step: 1, value: 30, unit: "" });
  const minDuration = slider("Durée mini par illustration", { min: 1.5, max: 10, step: 0.5, value: 3.2, unit: " s" });
  const provider = el("select", {}, [
    el("option", { value: "web", text: "Web (images du net)" }),
    el("option", { value: "openverse", text: "Openverse (Creative Commons)" }),
    el("option", { value: "wikimedia", text: "Wikimedia Commons" }),
  ]);
  const transitions = toggle("Transitions enchaînées", true, () => {});
  const kenBurns = toggle("Zoom lent (Ken Burns)", true, () => {});
  const subtitles = toggle("Sous-titres depuis la transcription", true, () => {});
  const pause = toggle("Points de contrôle (recommander)", true, () => {}, "La tâche s'arrête pour valider les silences, les mots-clés et l'export");

  host.append(
    el("div", { class: "muted", style: { fontSize: "12px" }, text: "Une seule tâche : silences, transcription, illustrations, sous-titres puis export. Tu valides aux étapes clés." }),
    denoise.node,
    minSilence.node,
    factor.node,
    maxClips.node,
    minDuration.node,
    el("div", { class: "ctrl select" }, [el("span", { class: "ctrl-label", text: "Source des images" }), provider]),
    transitions.node,
    kenBurns.node,
    subtitles.node,
    pause.node,
    el("div", { class: "footer" }, [
      el("button", {
        class: "primary",
        text: "🤖 Lancer le montage complet",
        onclick: () =>
          start({
            denoise: denoise.value(),
            minSilence: minSilence.value(),
            factor: factor.value(),
            maxClips: maxClips.value(),
            minDuration: minDuration.value(),
            provider: provider.value,
            transitions: transitions.value(),
            kenBurns: kenBurns.value(),
            subtitles: subtitles.value(),
            pause: pause.value(),
          }),
      }),
    ])
  );
}

async function start(options) {
  if (!S.project) return;
  if (!S.project.voice?.sourceId) {
    toast("Commence par enregistrer ou importer ta voix", "error");
    return;
  }
  try {
    const { job } = await api(`/api/projects/${S.project.id}/auto-full`, { method: "POST", body: options });
    toast("Montage complet lancé — tu peux continuer à travailler", "ok", 5000);
    track(job);
  } catch (e) {
    toast(`Montage complet impossible : ${e.message}`, "error", 8000);
  }
}

function track(jobId) {
  running = true;
  stopWatch?.();
  const host = $("#autoPanel");
  const stepsBox = el("div", { class: "auto-steps" });
  const message = el("div", { class: "muted", style: { fontSize: "12px" } });
  const bar = el("div", { class: "progress" }, [el("div")]);
  const logsBox = el("div", { class: "auto-logs" });
  const checkpointBox = el("div", { class: "auto-checkpoint" });
  host.innerHTML = "";
  host.append(stepsBox, bar, cancelJobButton("⏹ Annuler le montage"), message, checkpointBox, logsBox);

  const renderSteps = (job) => {
    stepsBox.innerHTML = "";
    for (const step of STEPS) {
      const done = (S.project?.auto?.completed || []).includes(step.id);
      const current = S.project?.auto?.stage === step.id || job?.checkpoint?.id === step.id;
      stepsBox.append(
        el("div", { class: `auto-step${done ? " done" : current ? " current" : ""}` }, [
          el("span", { text: step.icon }),
          el("span", { class: "auto-step-label", text: step.label }),
          el("span", { class: "muted", text: done ? "✓" : current ? "…" : "" }),
        ])
      );
    }
  };

  const renderLogs = (job) => {
    logsBox.innerHTML = "";
    for (const line of (job.logs || []).slice(-8)) logsBox.append(el("div", { class: "auto-log", text: line }));
  };

  stopWatch = watchJob(jobId, async (job) => {
    bar.firstChild.style.width = `${Math.round((job.progress || 0) * 100)}%`;
    message.textContent = job.message || "";
    renderSteps(job);
    renderLogs(job);

    if (job.status === "waiting" && job.checkpoint) {
      renderCheckpoint(job, checkpointBox, jobId);
      return;
    }
    checkpointBox.innerHTML = "";

    if (job.status === "done") {
      running = false;
      stopWatch?.();
      toast(job.message || "Montage complet terminé", "ok", 9000);
      const project = job.result?.project;
      if (project) {
        adoptProject(project);
        emit("project-external", project);
      }
      if (job.result?.output?.url) {
        host.append(
          el("div", { class: "notice" }, [
            el("a", { class: "btn-like", href: job.result.output.url, target: "_blank", text: `⬇️ ${job.result.output.file}` }),
          ])
        );
      }
    } else if (job.cancelled) {
      running = false;
      stopWatch?.();
      host.append(el("div", { class: "notice", text: "Tâche annulée — le projet garde ce qui a déjà été fait." }));
      host.append(el("div", { class: "footer" }, [el("button", { text: "↻ Reprendre", onclick: () => renderAutoPanel() })]));
    } else if (job.status === "error") {
      running = false;
      stopWatch?.();
      host.append(el("div", { class: "notice error", text: `Échec : ${job.error}` }));
      host.append(el("div", { class: "footer" }, [el("button", { text: "↻ Réessayer", onclick: () => renderAutoPanel() })]));
    }
  });
}

function renderCheckpoint(job, host, jobId) {
  const checkpoint = job.checkpoint;
  host.innerHTML = "";
  const payload = checkpoint.payload || {};
  const title = el("div", { class: "panel-title", text: `⏸ ${checkpoint.label}` });
  const body = el("div", { class: "auto-checkpoint-body" });
  let data = {};
  let action = "resume";

  const send = async (mode, extra = {}) => {
    host.innerHTML = `<div class="muted"><span class="spinner"></span> Reprise…</div>`;
    try {
      await resumeJob(jobId, { ...data, ...extra }, mode);
    } catch (e) {
      toast(`Reprise impossible : ${e.message}`, "error");
    }
  };

  if (checkpoint.id === "silences") {
    body.append(
      el("div", { class: "kv" }, [el("span", { text: "Silences accélérés" }), el("b", { text: String(payload.silences ?? 0) })]),
      el("div", { class: "kv" }, [el("span", { text: "Secondes gagnées" }), el("b", { text: `${payload.saved ?? 0} s` })]),
      el("div", { class: "kv" }, [el("span", { text: "Seuil de détection" }), el("b", { text: `${payload.thresholdDb} dB${payload.auto ? " (auto)" : ""}` })]),
      el("div", { class: "kv" }, [el("span", { text: "Durée du montage" }), el("b", { text: fmtTime(payload.duration || 0) })])
    );
    const threshold = slider("Seuil (dB)", { min: -60, max: -20, step: 1, value: Math.round(payload.thresholdDb ?? -35), unit: " dB" });
    const newFactor = slider("Accélération", { min: 2, max: 100, step: 1, value: payload.factor ?? 100, unit: "×" });
    const minSil = slider("Durée mini", { min: 0.15, max: 1.5, step: 0.05, value: payload.minSilence ?? 0.35, unit: " s" });
    const adjustBox = el("div", { class: "auto-adjust", hidden: true }, [threshold.node, newFactor.node, minSil.node]);
    body.append(
      el("button", {
        class: "ghost",
        text: "🔧 Ajuster",
        onclick: () => {
          adjustBox.hidden = !adjustBox.hidden;
        },
      }),
      adjustBox
    );
    host.append(
      title,
      body,
      el("div", { class: "footer" }, [
        el("button", { class: "danger", text: "Annuler", onclick: () => send("cancel") }),
        el("button", {
          text: "🔧 Appliquer les réglages",
          onclick: () =>
            send("resume", {
              adjust: { threshold: threshold.value(), factor: newFactor.value(), minSilence: minSil.value() },
            }),
        }),
        el("button", { class: "primary", text: "✅ Continuer", onclick: () => send("resume") }),
      ])
    );
    return;
  }

  if (checkpoint.id === "keywords") {
    let slots = JSON.parse(JSON.stringify(payload.slots || []));
    const list = el("div", { class: "auto-slots" });
    const renderList = () => {
      list.innerHTML = "";
      slots.forEach((slot, index) => {
        const input = el("input", { type: "text", value: slot.keyword, class: "menu-input" });
        input.addEventListener("input", () => (slot.keyword = input.value));
        const alt = el("select", {}, [
          el("option", { value: "", text: "autres…" }),
          ...(slot.alternatives || []).filter((a) => a !== slot.keyword).map((a) => el("option", { value: a, text: a })),
        ]);
        alt.addEventListener("change", () => {
          if (!alt.value) return;
          slot.keyword = alt.value;
          input.value = alt.value;
        });
        list.append(
          el("div", { class: "filerow" }, [
            el("span", { class: "muted", text: fmtTime(slot.start), style: { minWidth: "58px" } }),
            input,
            alt,
            el("button", {
              class: "ghost icon",
              text: "✕",
              title: "Ne pas illustrer ce passage",
              onclick: () => {
                slots = slots.filter((s) => s !== slot);
                renderList();
              },
            }),
          ])
        );
      });
    };
    renderList();
    host.append(
      title,
      el("div", { class: "muted", style: { fontSize: "12px" }, text: `${slots.length} passages illustrables. Corrige un mot-clé ou retire un passage, puis continue.` }),
      list,
      el("div", { class: "footer" }, [
        el("button", { class: "danger", text: "Annuler", onclick: () => send("cancel") }),
        el("button", {
          class: "primary",
          text: "✅ Continuer",
          onclick: () => send("resume", { slots: slots.filter((s) => String(s.keyword || "").trim()) }),
        }),
      ])
    );
    data = {};
    return;
  }

  if (checkpoint.id === "export") {
    const fileName = el("input", { type: "text", value: `${(S.project?.name || "montage").replace(/[^\w.\- ]+/g, "_")}.mp4`, style: { width: "100%" } });
    const crf = slider("Qualité (CRF, plus bas = meilleur)", { min: 12, max: 32, step: 1, value: payload.quality ?? 20, unit: "" });
    body.append(
      el("div", { class: "kv" }, [el("span", { text: "Durée" }), el("b", { text: fmtTime(payload.duration || 0) })]),
      el("div", { class: "kv" }, [el("span", { text: "Clips vidéo" }), el("b", { text: String(payload.clips ?? 0) })]),
      el("div", { class: "kv" }, [el("span", { text: "Incrustations / textes" }), el("b", { text: `${payload.overlays ?? 0} / ${payload.texts ?? 0}` })]),
      el("div", { class: "kv" }, [el("span", { text: "Sous-titres" }), el("b", { text: payload.subtitles ? "oui" : "non" })])
    );
    host.append(
      title,
      body,
      el("label", { class: "ctrl field" }, [el("span", { class: "ctrl-label", text: "Nom du fichier" }), fileName]),
      crf.node,
      el("div", { class: "footer" }, [
        el("button", { class: "danger", text: "Annuler", onclick: () => send("cancel") }),
        el("button", {
          class: "primary",
          text: "🎬 Lancer l'export",
          onclick: () => send("resume", { fileName: fileName.value, crf: crf.value() }),
        }),
      ])
    );
    return;
  }

  host.append(
    title,
    el("div", { class: "muted", text: checkpoint.message || "" }),
    el("div", { class: "footer" }, [
      el("button", { class: "danger", text: "Annuler", onclick: () => send("cancel") }),
      el("button", { class: "primary", text: "✅ Continuer", onclick: () => send("resume") }),
    ])
  );
}
