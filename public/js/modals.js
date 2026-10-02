import { S, emit, duration, clips } from "./state.js";
import { $, el, api, toast, openModal, clamp, fmtDuration, fmtTime, watchJob } from "./api.js";

// ---------------------------------------------------------------------------
// Enregistrement micro
// ---------------------------------------------------------------------------
export async function openRecorder() {
  let stream = null;
  let recorder = null;
  let chunks = [];
  let analyser = null;
  let audioCtx = null;
  let rafId = null;
  let startedAt = 0;
  let blob = null;

  const preview = el("audio", { controls: true, style: { width: "100%", marginTop: "10px", display: "none" } });
  const meter = el("div", { class: "progress" }, [el("div")]);
  const timer = el("div", { class: "muted", style: { fontVariantNumeric: "tabular-nums" } , text: "0:00.0" });
  const status = el("div", { class: "muted", text: "Prêt à enregistrer." });
  const btnStart = el("button", { class: "primary", text: "⏺️ Enregistrer" });
  const btnStop = el("button", { text: "⏹️ Stop", disabled: true });
  const btnVoice = el("button", { class: "primary", text: "🎙️ Utiliser comme voix", disabled: true });
  const trackSelect = el("select");
  const btnTrack = el("button", { text: "➕ Ajouter comme musique/bruitage", disabled: true });

  const fillTracks = () => {
    trackSelect.innerHTML = "";
    for (const track of S.project?.audioTracks || []) {
      trackSelect.append(el("option", { value: track.id, text: track.name }));
    }
  };
  fillTracks();

  const stopMeter = () => {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
  };

  const tickMeter = () => {
    if (!analyser) return;
    const data = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(data);
    let peak = 0;
    for (const v of data) peak = Math.max(peak, Math.abs(v - 128) / 128);
    meter.firstChild.style.width = `${Math.round(peak * 100)}%`;
    timer.textContent = `${(performance.now() - startedAt) / 1000 < 60 ? fmtTime((performance.now() - startedAt) / 1000) : fmtDuration((performance.now() - startedAt) / 1000)}`;
    rafId = requestAnimationFrame(tickMeter);
  };

  btnStart.addEventListener("click", async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    } catch (e) {
      status.textContent = `Micro inaccessible : ${e.message}`;
      return;
    }
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);

    const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", ""].find(
      (m) => !m || (window.MediaRecorder && MediaRecorder.isTypeSupported(m))
    );
    recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    chunks = [];
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.onstop = () => {
      blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
      preview.src = URL.createObjectURL(blob);
      preview.style.display = "block";
      btnVoice.disabled = false;
      btnTrack.disabled = false;
      status.textContent = `Prise terminée — ${fmtDuration(blob.size / 16000)} environ.`;
    };
    recorder.start(250);
    startedAt = performance.now();
    btnStart.disabled = true;
    btnStop.disabled = false;
    status.innerHTML = '<span class="rec-dot"></span> Enregistrement… parle normalement, sans traitement du navigateur.';
    tickMeter();
  });

  btnStop.addEventListener("click", () => {
    try {
      recorder?.stop();
      stream?.getTracks().forEach((t) => t.stop());
      audioCtx?.close();
    } catch {}
    stopMeter();
    btnStart.disabled = false;
    btnStop.disabled = true;
    meter.firstChild.style.width = "0%";
  });

  const upload = async (role, name) => {
    if (!blob) return;
    const status2 = toast("Envoi de la prise…", "info", 60000);
    try {
      const form = new FormData();
      const ext = (recorder?.mimeType || "").includes("mp4") ? "m4a" : "webm";
      form.append("file", new File([blob], `${name}.${ext}`, { type: blob.type || "audio/webm" }));
      form.append("role", role);
      form.append("name", `${name}.${ext}`);
      const data = await api(`/api/projects/${S.project.id}/upload`, { method: "POST", form });
      status2.remove();
      toast(role === "voice" ? "Piste voix mise à jour ✓" : "Piste ajoutée ✓", "ok");
      S.project = data.project;
      emit("project-external", data.project);
      close();
    } catch (e) {
      status2.remove();
      toast(`Envoi impossible : ${e.message}`, "error");
    }
  };

  btnVoice.addEventListener("click", () => upload("voice", "prise-micro"));

  btnTrack.addEventListener("click", async () => {
    if (!blob) return;
    const trackId = trackSelect.value;
    await upload("music", "prise-audio");
    const track = S.project?.audioTracks?.find((t) => t.id === trackId);
    const source = S.project?.sources?.[S.project.sources.length - 1];
    if (track && source) {
      track.clips.push({
        id: `clip_${Math.random().toString(36).slice(2, 9)}`,
        sourceId: source.id,
        start: S.playhead,
        duration: source.duration || 3,
        offset: 0,
        gain: 1,
        fadeIn: 0,
        fadeOut: 0,
      });
      emit("persist");
      emit("render");
    }
  });

  const close = openModal(() =>
    el("div", {}, [
      el("h2", { text: "🎙️ Enregistrer ma voix" }),
      el("div", { class: "muted", style: { fontSize: "12px", marginBottom: "8px" }, text: "Traitement du navigateur désactivé : le son brut est conservé pour un meilleur débruitage ensuite." }),
      meter,
      el("div", { style: { display: "flex", alignItems: "center", gap: "12px", margin: "10px 0" } }, [btnStart, btnStop, timer]),
      status,
      preview,
      el("div", { class: "divider" }),
      el("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" } }, [btnVoice, trackSelect, btnTrack]),
    ])
  );
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
const PRESETS = [
  { label: "YouTube 1080p (16:9)", width: 1920, height: 1080 },
  { label: "720p (16:9)", width: 1280, height: 720 },
  { label: "Vertical (9:16)", width: 1080, height: 1920 },
  { label: "Carré (1:1)", width: 1080, height: 1080 },
];

export function openExport() {
  if (!S.build) {
    toast("Ajoute d'abord une piste voix", "error");
    return;
  }
  const preset = el("select");
  PRESETS.forEach((p, i) => preset.append(el("option", { value: String(i), text: p.label })));
  const fps = el("select", {}, [24, 25, 30, 50, 60].map((f) => el("option", { value: String(f), text: `${f} i/s`, selected: f === (S.project.output.fps || 30) })));
  const quality = el("input", { type: "range", min: "14", max: "28", step: "1", value: String(S.project.output.crf ?? 20) });
  const qualityVal = el("span", { class: "val", text: `CRF ${S.project.output.crf ?? 20}` });
  quality.addEventListener("input", () => (qualityVal.textContent = `CRF ${quality.value}`));
  const normalize = el("input", { type: "checkbox", checked: S.project.output.normalize !== false });
  const burnSubtitles = el("input", { type: "checkbox", checked: !!S.project.subtitles?.enabled });
  burnSubtitles.addEventListener("change", async () => {
    try {
      const { project } = await api(`/api/projects/${S.project.id}/update`, {
        method: "POST",
        body: { subtitles: { ...(S.project.subtitles || {}), enabled: burnSubtitles.checked } },
      });
      S.project = project;
      emit("subtitles-loaded");
      emit("project-external", project);
      toast(burnSubtitles.checked ? "Sous-titres incrustés au rendu" : "Sous-titres désactivés", "ok", 3500);
    } catch (e) {
      toast(e.message, "error");
    }
  });
  const fileName = el("input", { type: "text", value: `${(S.project.name || "montage").replace(/[^\w\- ]+/g, "")}.mp4` });
  const progress = el("div", { class: "progress", hidden: true }, [el("div")]);
  const status = el("div", { class: "muted" });
  const resultBox = el("div");

  const btn = el("button", { class: "primary", text: "🎬 Lancer le rendu" });
  btn.addEventListener("click", async () => {
    const p = PRESETS[Number(preset.value)] || PRESETS[0];
    btn.disabled = true;
    progress.hidden = false;
    status.textContent = "Préparation…";
    try {
      const { job } = await api(`/api/projects/${S.project.id}/export`, {
        method: "POST",
        body: {
          fileName: fileName.value.trim() || "montage.mp4",
          width: p.width,
          height: p.height,
          fps: Number(fps.value),
          crf: Number(quality.value),
          normalize: normalize.checked,
        },
      });
      watchJob(job, (state) => {
        if (state.status === "running") {
          progress.firstChild.style.width = `${Math.round(state.progress * 100)}%`;
          status.innerHTML = `<span class="spinner"></span> ${state.message} (${Math.round(state.progress * 100)}%)`;
          return;
        }
        if (state.status === "error") {
          status.textContent = `Échec : ${state.error}`;
          btn.disabled = false;
          return;
        }
        status.textContent = "Rendu terminé ✓";
        progress.firstChild.style.width = "100%";
        const url = state.result?.url;
        resultBox.innerHTML = "";
        resultBox.append(
          el("div", { class: "panel-actions" }, [
            el("a", { href: url, download: "", class: "", style: { textDecoration: "none" } }, [
              el("button", { class: "primary", text: "⬇️ Télécharger la vidéo" }),
            ]),
            el("a", { href: url, target: "_blank", style: { textDecoration: "none" } }, [el("button", { text: "▶️ Ouvrir" })]),
          ]),
          el("div", { class: "muted", style: { fontSize: "11px", marginTop: "6px" }, text: `Fichier : data/projects/${S.project.id}/build/${state.result?.file || ""}` })
        );
      });
    } catch (e) {
      status.textContent = `Erreur : ${e.message}`;
      btn.disabled = false;
    }
  });

  openModal(() =>
    el("div", {}, [
      el("h2", { text: "🎬 Export MP4" }),
      el("div", { class: "row" }, [el("div", {}, [el("label", { text: "Format" }), preset]), el("div", {}, [el("label", { text: "Cadence" }), fps])]),
      el("div", { class: "row" }, [
        el("div", {}, [el("label", { text: "Qualité (plus petit = mieux)" }), el("div", { style: { display: "flex", gap: "8px", alignItems: "center" } }, [quality, qualityVal])]),
        el("div", {}, [el("label", { text: "Normaliser le son" }), el("div", {}, [normalize])]),
      ]),
      el("div", { class: "row" }, [el("div", {}, [el("label", { text: "Nom du fichier" }), fileName])]),
      el("div", { class: "prop-row" }, [
        el("span", { text: S.project?.transcript ? "Incruster les sous-titres" : "Sous-titres (transcription requise)" }),
        burnSubtitles,
      ]),
      el("div", { class: "muted", style: { fontSize: "12px" }, text: `Durée du montage : ${fmtDuration(duration())} · ${clips().length} clips vidéo` }),
      progress,
      status,
      resultBox,
      el("div", { class: "footer" }, [el("button", { text: "Fermer", onclick: () => closeModal() }), btn]),
    ])
  );
}

function closeModal() {
  $("#modal").hidden = true;
}

// ---------------------------------------------------------------------------
// Réglages
// ---------------------------------------------------------------------------
export function openSettings() {
  const box = el("div", {}, [el("h2", { text: "⚙️ Réglages" })]);
  const statusBox = el("div");
  const refresh = () => {
    const w = S.setup?.whisper;
    statusBox.innerHTML = "";
    statusBox.append(el("div", { class: "kv" }, [el("span", { text: "Binaire whisper" }), el("b", { text: w?.binary || "non installé" })]));
    const list = el("div", { class: "filelist" });
    for (const model of w?.models || []) {
      const row = el("div", { class: "filerow" }, [
        el("div", {}, [el("div", { text: model.label }), el("div", { class: "meta", text: `${model.id} · ${model.sizeMb} Mo` })]),
        model.installed
          ? el("span", { class: "muted", text: "installé ✓" })
          : el("button", {
              text: "⬇️ Installer",
              onclick: async () => {
                const { job } = await api("/api/setup/whisper", { method: "POST", body: { model: model.id } });
                toast("Installation lancée…", "info");
                watchJob(job, (state) => {
                  if (state.status !== "running") {
                    toast(state.status === "done" ? `${model.label} installé ✓` : `Échec : ${state.error}`, state.status === "done" ? "ok" : "error");
                    emit("refresh-setup");
                    refresh();
                  }
                });
              },
            }),
      ]);
      list.append(row);
    }
    statusBox.append(list);
    statusBox.append(el("div", { class: "divider" }));
    statusBox.append(el("div", { class: "kv" }, [el("span", { text: "Modèle RNNoise" }), el("b", { text: w?.rnnoise || "non installé" })]));
    if (!w?.rnnoise) {
      statusBox.append(
        el("button", {
          text: "⬇️ Télécharger le modèle RNNoise",
          onclick: async () => {
            const { job } = await api("/api/setup/rnnoise", { method: "POST" });
            toast("Téléchargement RNNoise…", "info");
            watchJob(job, (state) => {
              if (state.status !== "running") {
                toast(state.status === "done" ? "RNNoise installé ✓" : `Échec : ${state.error}`, state.status === "done" ? "ok" : "error");
                emit("refresh-setup");
                refresh();
              }
            });
          },
        })
      );
    }
    statusBox.append(el("div", { class: "divider" }));
    statusBox.append(el("div", { class: "kv" }, [el("span", { text: "FFmpeg" }), el("b", { text: S.setup?.ffmpeg ? "détecté ✓" : "absent ✗" })]));
  };
  refresh();

  const output = S.project.output;
  const widthInput = el("input", { type: "number", value: output.width });
  const heightInput = el("input", { type: "number", value: output.height });
  widthInput.addEventListener("change", () => saveOutput({ width: Number(widthInput.value) }));
  heightInput.addEventListener("change", () => saveOutput({ height: Number(heightInput.value) }));

  async function saveOutput(patch) {
    const { project } = await api(`/api/projects/${S.project.id}/update`, { method: "POST", body: { output: patch } });
    S.project = project;
    emit("project-external", project);
  }

  box.append(
    el("div", { class: "row" }, [
      el("div", {}, [el("label", { text: "Largeur de sortie" }), widthInput]),
      el("div", {}, [el("label", { text: "Hauteur de sortie" }), heightInput]),
    ]),
    el("div", { class: "divider" }),
    statusBox,
    el("div", { class: "footer" }, [el("button", { text: "Fermer", onclick: () => closeModal() })])
  );
  openModal(() => box);
}

// ---------------------------------------------------------------------------
// Projets
// ---------------------------------------------------------------------------
export async function openProjects() {
  const list = el("div", { class: "filelist" });
  const refresh = async () => {
    list.innerHTML = "";
    const { projects } = await api("/api/projects");
    for (const p of projects) {
      const row = el("div", { class: "filerow" }, [
        el("div", {}, [
          el("div", { text: p.name }),
          el("div", { class: "meta", text: `${p.sources} sources · ${p.clips} clips · ${fmtDuration(p.duration)}` }),
        ]),
        el("div", { style: { display: "flex", gap: "6px" } }, [
          el("button", {
            class: p.id === S.project?.id ? "" : "primary",
            text: p.id === S.project?.id ? "ouvert" : "Ouvrir",
            onclick: async () => {
              const { project } = await api(`/api/projects/${p.id}`);
              S.project = project;
              emit("project-external", project);
              closeModal();
              toast(`Projet « ${project.name} » ouvert`, "ok");
            },
          }),
          el("a", {
            class: "btn-like",
            href: `/api/projects/${p.id}/archive`,
            title: "Sauvegarder le projet complet (projet + médias) dans un fichier",
            text: "💾",
          }),
          el("button", {
            class: "danger",
            text: "🗑️",
            onclick: async () => {
              await api(`/api/projects/${p.id}`, { method: "DELETE" });
              toast("Projet supprimé");
              refresh();
            },
          }),
        ]),
      ]);
      list.append(row);
    }
    if (!projects.length) list.append(el("div", { class: "muted", text: "Aucun projet." }));
  };
  refresh();

  const nameInput = el("input", { type: "text", placeholder: "Nom du nouveau montage" });
  const createForm = el("form", { class: "search-form" }, [nameInput, el("button", { class: "primary", type: "submit", text: "➕ Créer" })]);
  createForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const { project } = await api("/api/projects", { method: "POST", body: { name: nameInput.value.trim() || "Nouveau montage" } });
    S.project = project;
    emit("project-external", project);
    closeModal();
  });

  // restauration d'une sauvegarde .tar.gz exportée depuis l'app
  const archiveInput = el("input", { type: "file", accept: ".gz,.tar,.tgz,application/gzip,application/x-tar", hidden: true });
  archiveInput.addEventListener("change", async () => {
    const file = archiveInput.files?.[0];
    if (!file) return;
    const note = toast("Restauration de la sauvegarde…", "info", 120000);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/projects/import", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
      S.project = data.project;
      emit("project-external", data.project);
      note.remove();
      toast(`Projet restauré : ${data.project.name}`, "ok", 6000);
      closeModal();
    } catch (e) {
      note.remove();
      toast(`Restauration impossible : ${e.message}`, "error", 8000);
      archiveInput.value = "";
    }
  });
  const importButton = el("button", {
    text: "📥 Restaurer une sauvegarde",
    title: "Importer un fichier .tar.gz créé avec le bouton 💾",
    onclick: () => archiveInput.click(),
  });

  openModal(() =>
    el("div", {},
      [
        el("h2", { text: "🗂️ Projets" }),
        createForm,
        el("div", { class: "divider" }),
        list,
        el("div", { class: "muted", style: { fontSize: "11px", marginTop: "10px" }, text: "💾 télécharge une sauvegarde complète (médias inclus) ; 📥 restaure une sauvegarde dans un nouveau projet." }),
        el("div", { class: "footer" }, [importButton, archiveInput, el("button", { text: "Fermer", onclick: () => closeModal() })]),
      ]
    )
  );
}

// ---------------------------------------------------------------------------
// Montage automatique
// ---------------------------------------------------------------------------
export function openAuto() {
  if (!S.project?.transcript) {
    toast("Lance d'abord la transcription Whisper", "error");
    return;
  }
  const maxClips = el("input", { type: "range", min: "5", max: "60", step: "1", value: "28" });
  const maxClipsVal = el("span", { class: "val", text: "28" });
  maxClips.addEventListener("input", () => (maxClipsVal.textContent = maxClips.value));
  const minDur = el("input", { type: "range", min: "1.5", max: "8", step: "0.5", value: "3.2" });
  const minDurVal = el("span", { class: "val", text: "3.2 s" });
  minDur.addEventListener("input", () => (minDurVal.textContent = `${minDur.value} s`));
  const keywordsBox = el("div", { class: "filelist", style: { maxHeight: "220px" } });
  let slots = [];

  const renderSlots = () => {
    keywordsBox.innerHTML = "";
    if (!slots.length) {
      keywordsBox.append(el("div", { class: "muted", text: "Aucun mot-clé détecté — vérifie la transcription." }));
      return;
    }
    for (const slot of slots) {
      const input = el("input", { type: "text", value: slot.keyword, style: { width: "160px" } });
      input.addEventListener("input", () => (slot.keyword = input.value));
      const alternatives = el("select", { title: "Autres mots-clés possibles" }, [
        el("option", { value: "", text: "autres…" }),
        ...(slot.alternatives || []).map((alt) => el("option", { value: alt, text: alt })),
      ]);
      alternatives.addEventListener("change", () => {
        if (!alternatives.value) return;
        slot.keyword = alternatives.value;
        input.value = alternatives.value;
      });
      const remove = el("button", {
        class: "ghost",
        text: "✕",
        title: "Ne pas illustrer ce passage",
        onclick: () => {
          slots = slots.filter((s) => s !== slot);
          renderSlots();
        },
      });
      keywordsBox.append(
        el("div", { class: "filerow" }, [
          el("div", { style: { minWidth: "74px" } }, [
            el("div", { class: "meta", text: `${fmtTime(slot.start)} → ${fmtTime(slot.end)}` }),
          ]),
          input,
          alternatives,
          remove,
        ])
      );
    }
  };

  const loadSlots = async () => {
    keywordsBox.innerHTML = `<div class="muted"><span class="spinner"></span> Analyse de la transcription…</div>`;
    try {
      const data = await api(`/api/projects/${S.project.id}/keywords?minDuration=${Number(minDur.value)}`);
      slots = data.slots || [];
    } catch (e) {
      slots = [];
      toast(`Mots-clés : ${e.message}`, "error");
    }
    renderSlots();
  };
  const provider = el("select", {}, [
    el("option", { value: "web", text: "Web (images du net)" }),
    el("option", { value: "openverse", text: "Openverse (Creative Commons)" }),
    el("option", { value: "wikimedia", text: "Wikimedia Commons" }),
  ]);
  const transitions = el("input", { type: "checkbox", checked: true });
  const kenBurns = el("input", { type: "checkbox", checked: true });
  const subtitles = el("input", { type: "checkbox", checked: !!S.project?.subtitles?.enabled });
  const replace = el("input", { type: "checkbox", checked: true });
  const progress = el("div", { class: "progress", hidden: true }, [el("div")]);
  const status = el("div", { class: "muted" });
  const btn = el("button", { class: "primary", text: "🪄 Générer le montage" });

  btn.addEventListener("click", async () => {
    btn.disabled = true;
    progress.hidden = false;
    try {
      const trimmed = slots
        .map((slot) => ({ start: slot.start, end: slot.end, keyword: (slot.keyword || "").trim() }))
        .filter((slot) => slot.keyword);
      const { job } = await api(`/api/projects/${S.project.id}/auto`, {
        method: "POST",
        body: {
          maxClips: Number(maxClips.value),
          minDuration: Number(minDur.value),
          provider: provider.value,
          transitions: transitions.checked,
          kenBurns: kenBurns.checked,
          subtitles: subtitles.checked,
          replace: replace.checked,
          slots: trimmed.length ? trimmed : undefined,
        },
      });
      watchJob(job, (state) => {
        if (state.status === "running") {
          progress.firstChild.style.width = `${Math.round(state.progress * 100)}%`;
          status.innerHTML = `<span class="spinner"></span> ${state.message}`;
          return;
        }
        if (state.status === "error") {
          status.textContent = `Échec : ${state.error}`;
          btn.disabled = false;
          return;
        }
        status.textContent = state.message;
        toast(state.message, "ok");
        if (state.result?.project) {
          S.project = state.result.project;
          emit("project-external", state.result.project);
        }
        closeModal();
      });
    } catch (e) {
      status.textContent = `Erreur : ${e.message}`;
      btn.disabled = false;
    }
  });

  loadSlots();
  openModal(() =>
    el("div", {}, [
      el("h2", { text: "🪄 Montage automatique" }),
      el("div", { class: "muted", style: { fontSize: "12px", marginBottom: "8px" }, text: "L'outil repère les noms concrets et les thèmes récurrents de ta transcription. Vérifie la liste ci-dessous, corrige ou retire des passages, puis lance la génération." }),
      el("div", { class: "panel-head" }, [
        el("div", { class: "panel-title", text: "Mots-clés retenus" }),
        el("button", { class: "ghost", text: "🔄 Recalculer", onclick: loadSlots }),
      ]),
      keywordsBox,
      el("div", { class: "divider" }),
      el("div", { class: "prop-row" }, [el("span", { text: "Nombre max d'images" }), maxClips, maxClipsVal]),
      el("div", { class: "prop-row" }, [el("span", { text: "Durée mini par image" }), minDur, minDurVal]),
      el("div", { class: "prop-row" }, [el("span", { text: "Source des images" }), provider]),
      el("div", { class: "prop-row" }, [el("span", { text: "Transitions enchaînées" }), transitions]),
      el("div", { class: "prop-row" }, [el("span", { text: "Zoom lent (Ken Burns)" }), kenBurns]),
      el("div", { class: "prop-row" }, [el("span", { text: "Activer les sous-titres" }), subtitles]),
      el("div", { class: "prop-row" }, [el("span", { text: "Remplacer le montage actuel" }), replace]),
      progress,
      status,
      el("div", { class: "footer" }, [el("button", { text: "Annuler", onclick: () => closeModal() }), btn]),
    ])
  );
}
