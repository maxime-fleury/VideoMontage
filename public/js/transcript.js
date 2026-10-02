import { S, emit, on, clips, adoptProject } from "./state.js";
import { $, el, api, toast, openModal, fmtTime, clamp } from "./api.js";
import { openIllustrationPicker } from "./illustrations.js";

export function initTranscript() {
  on("project", renderTranscript);
}

function isIllustrated(start) {
  return clips().some((c) => start >= c.start - 0.6 && start <= c.start + c.duration + 0.6);
}

/** Durée d'affichage proposée : jusqu'au prochain mot, min 2 s. */
function suggestedDuration(segment, word) {
  const all = (S.project?.transcript?.segments || []).flatMap((s) => s.words || []);
  const index = all.findIndex((w) => Math.abs(w.s - word.s) < 0.02);
  const next = index >= 0 ? all[index + 1] : null;
  if (!next) return 3;
  return clamp(next.s - word.s, 1.2, 8);
}

function openWordEditor(word, segment) {
  const input = el("input", { type: "text", value: word.w });
  const status = el("div", { class: "muted", style: { fontSize: "12px" } });
  let close = null;

  const refresh = async () => {
    const { project } = await api(`/api/projects/${S.project.id}`);
    adoptProject(project);
    emit("project-external", project);
  };

  const save = async () => {
    try {
      const { project } = await api(`/api/projects/${S.project.id}/transcript/edit`, {
        method: "POST",
        body: { action: "update-word", segmentId: segment.id, index: segment.words.indexOf(word), text: input.value },
      });
      adoptProject(project);
      emit("project-external", project);
      toast("Mot corrigé ✓", "ok");
      close?.();
    } catch (e) {
      status.textContent = e.message;
    }
  };

  const modal = el("div", {}, [
    el("h2", { text: `« ${word.w} »` }),
    el("div", { class: "muted", style: { fontSize: "12px", marginBottom: "12px" }, text: `À ${fmtTime(word.s)} · durée ${(word.e - word.s).toFixed(2)} s` }),
    el("div", { class: "row" }, [
      el("button", {
        class: "primary",
        text: "🎨 Illustrer ce mot (3 propositions)",
        onclick: () => {
          close?.();
          openIllustrationPicker({
            keyword: word.w,
            start: word.s,
            duration: suggestedDuration(segment, word),
            slot: { start: Math.max(0, word.s - 0.4), end: clamp(word.s + suggestedDuration(segment, word), word.s + 1, segment.end + 1) },
          });
        },
      }),
      el("button", {
        text: "🖼️ Chercher une autre expression",
        title: "Ouvre le sélecteur avec un mot-clé libre",
        onclick: () => {
          close?.();
          openIllustrationPicker({ keyword: word.w, start: word.s, duration: suggestedDuration(segment, word) });
        },
      }),
    ]),
    el("div", { class: "divider" }),
    el("label", { text: "Corriger le mot (la transcription est recalculée, sous-titres inclus)" }),
    el("div", { class: "search-form" }, [input, el("button", { class: "primary", text: "💾 Enregistrer", onclick: save })]),
    el("div", { class: "muted", style: { fontSize: "11px" }, text: `Phrase : ${segment.text.slice(0, 120)}` }),
    status,
    el("div", { class: "footer" }, [
      el("button", {
        class: "danger",
        text: "🗑️ Supprimer le mot",
        onclick: async () => {
          try {
            const { project } = await api(`/api/projects/${S.project.id}/transcript/edit`, {
              method: "POST",
              body: { action: "delete-word", segmentId: segment.id, index: segment.words.indexOf(word) },
            });
            adoptProject(project);
            emit("project-external", project);
            toast("Mot supprimé", "ok");
            close?.();
          } catch (e) {
            status.textContent = e.message;
          }
        },
      }),
      el("button", {
        class: "danger",
        text: "🗑️ Supprimer la phrase",
        onclick: async () => {
          try {
            const { project } = await api(`/api/projects/${S.project.id}/transcript/edit`, {
              method: "POST",
              body: { action: "delete-segment", segmentId: segment.id },
            });
            adoptProject(project);
            emit("project-external", project);
            toast("Phrase supprimée de la transcription", "ok");
            close?.();
          } catch (e) {
            status.textContent = e.message;
          }
        },
      }),
      el("button", { text: "Fermer", onclick: () => close?.() }),
    ]),
  ]);
  close = openModal(() => modal);
  input.focus();
  input.select?.();
}

export function renderTranscript() {
  const host = $("#transcript");
  if (!host) return;
  const transcript = S.project?.transcript;
  host.innerHTML = "";
  const info = $("#transcriptInfo");

  if (!transcript || !transcript.segments?.length) {
    host.append(el("div", { class: "empty", html: "Pas encore de transcription — clique sur <b>🗣️ Transcrire</b>." }));
    if (info) info.textContent = "Clique un mot pour l'illustrer ou le corriger";
    return;
  }

  const stale = Boolean(S.build && transcript.hash && transcript.hash !== S.build.hash);
  const wordCount = transcript.segments.reduce((n, s) => n + (s.words?.length || 0), 0);
  if (info) {
    info.textContent = `${transcript.segments.length} phrases · ${wordCount} mots${stale ? " · obsolète" : ""}`;
    info.title = stale
      ? "Transcription antérieure aux coupes: relance-la pour recaler les mots sur la vidéo"
      : "Clique un mot pour l'illustrer ou le corriger";
  }

  const frag = document.createDocumentFragment();
  if (stale) {
    frag.append(
      el("div", {
        class: "notice",
        text: "⚠️ Transcription antérieure à tes coupes — relance la transcription pour recaler les mots sur la vidéo montée.",
      })
    );
  }
  for (const segment of transcript.segments) {
    const block = el("div", { class: "seg" });
    block.append(
      el("div", {
        class: "seg-head",
        text: `${fmtTime(segment.start)} → ${fmtTime(segment.end)}`,
        title: "Aller à ce moment",
        onclick: () => emit("seek", segment.start),
      })
    );
    const words = el("div");
    for (const word of segment.words || []) {
      if (!/[\p{L}\p{N}]/u.test(word.w || "")) continue;
      const span = el("span", {
        class: `word${isIllustrated(word.s) ? " illustrated" : ""}${word.edited ? " edited" : ""}`,
        text: word.w,
        title: word.edited
          ? `${fmtTime(word.s)} — mot corrigé à la main`
          : `${fmtTime(word.s)} — cliquer pour illustrer / corriger`,
        onclick: () => {
          S.activeWord = { word: word.w, start: word.s, end: word.e };
          emit("seek", word.s);
          openWordEditor(word, segment);
        },
      });
      if (S.activeWord && Math.abs(S.activeWord.start - word.s) < 0.01) span.classList.add("active");
      words.append(span, document.createTextNode(" "));
    }
    block.append(words);
    frag.append(block);
  }
  host.append(frag);
}

export function highlightActiveWord() {
  for (const node of document.querySelectorAll(".word.active")) node.classList.remove("active");
  if (!S.activeWord) return;
}
