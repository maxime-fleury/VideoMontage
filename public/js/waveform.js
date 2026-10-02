import { S, emit, duration, on } from "./state.js";
import { $, clamp } from "./api.js";

let canvas, ctx, wrap;
let dragStart = null;
let dragging = false;

export function initWaveform() {
  canvas = $("#waveform");
  wrap = $("#waveWrap");
  ctx = canvas.getContext("2d");

  canvas.addEventListener("mousedown", (e) => {
    if (!S.build) return;
    const t = timeAtEvent(e);
    dragStart = t;
    dragging = true;
    S.selection = null;
    emit("render-waveform");
    window.addEventListener("mousemove", onDragMove);
    window.addEventListener("mouseup", onDragEnd);
  });
  canvas.addEventListener("dblclick", () => {
    S.selection = null;
    emit("render-waveform");
    emit("selection");
  });
  wrap.addEventListener("scroll", () => {
    S.scroll = wrap.scrollLeft;
    emit("scroll", S.scroll);
  });
  wrap.addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
      emit("zoom", { factor, anchorTime: timeAtEvent(e) });
    },
    { passive: false }
  );

  on("render-waveform", drawWaveform);
  window.addEventListener("resize", drawWaveform);
}

function timeAtEvent(e) {
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  return clamp(x / S.pxPerSec, 0, duration());
}

function onDragMove(e) {
  if (!dragging) return;
  const t = timeAtEvent(e);
  const start = Math.min(dragStart, t);
  const end = Math.max(dragStart, t);
  S.selection = end - start > 0.02 ? { start, end } : null;
  emit("render-waveform");
  emit("selection");
}

function onDragEnd(e) {
  dragging = false;
  window.removeEventListener("mousemove", onDragMove);
  window.removeEventListener("mouseup", onDragEnd);
  if (S.selection) emit("selection");
  else if (e) emit("seek", timeAtEvent(e));
}

/** Peaks interpolés pour un instant donné. */
function peakAt(peaks, buckets, t, dur) {
  if (!peaks || !buckets || dur <= 0) return { min: 0, max: 0 };
  const pos = (clamp(t, 0, dur) / dur) * (buckets - 1);
  const i = Math.floor(pos);
  const j = Math.min(buckets - 1, i + 1);
  const f = pos - i;
  const min = peaks[i * 2] * (1 - f) + peaks[j * 2] * f;
  const max = peaks[i * 2 + 1] * (1 - f) + peaks[j * 2 + 1] * f;
  return { min, max };
}

export function drawWaveform() {
  if (!canvas) return;
  const dur = duration();
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = Math.max(wrap.clientWidth, dur * S.pxPerSec);
  const cssHeight = wrap.clientHeight || 140;
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  if (canvas.width !== Math.floor(cssWidth * dpr) || canvas.height !== Math.floor(cssHeight * dpr)) {
    canvas.width = Math.floor(cssWidth * dpr);
    canvas.height = Math.floor(cssHeight * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  // fond
  ctx.fillStyle = "#0b0e13";
  ctx.fillRect(0, 0, cssWidth, cssHeight);

  if (!S.build || dur <= 0) {
    ctx.fillStyle = "#8f9bab";
    return;
  }

  const mid = cssHeight / 2;
  const amp = (cssHeight / 2) * 0.92;

  // grille: secondes + libellés
  const step = S.pxPerSec > 90 ? 1 : S.pxPerSec > 35 ? 5 : 15;
  ctx.font = "10px 'Segoe UI', sans-serif";
  for (let t = 0; t <= dur; t += step) {
    const x = t * S.pxPerSec;
    ctx.strokeStyle = t % (step * 5) === 0 ? "#222b36" : "#161c24";
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, cssHeight);
    ctx.stroke();
    if (t % (step * 5) === 0) {
      ctx.fillStyle = "#5c6875";
      ctx.fillText(`${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`, x + 3, cssHeight - 4);
    }
  }

  // zones accélérées (silences ×N)
  const segments = S.build.segments || [];
  ctx.fillStyle = "rgba(255, 120, 120, 0.14)";
  for (const seg of segments) {
    if (seg.tempo > 1.001) ctx.fillRect(seg.outStart * S.pxPerSec, 0, Math.max(1, (seg.outEnd - seg.outStart) * S.pxPerSec), cssHeight);
  }
  // silences détectés (prévisualisation)
  if (S.detected) {
    ctx.fillStyle = "rgba(255, 210, 90, 0.16)";
    for (const range of S.detected) {
      ctx.fillRect(range.start * S.pxPerSec, 0, Math.max(1, (range.end - range.start) * S.pxPerSec), cssHeight);
    }
  }

  // forme d'onde
  const peaks = S.build.peaks;
  const buckets = S.build.peaksBuckets;
  ctx.fillStyle = "#6b8cff";
  const width = Math.floor(cssWidth);
  for (let x = 0; x < width; x++) {
    const t = (x + 0.5) / S.pxPerSec;
    if (t > dur) break;
    const { min, max } = peakAt(peaks, buckets, t, dur);
    const y1 = mid - max * amp;
    const y2 = mid - min * amp;
    ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
  }
  // ligne médiane
  ctx.fillStyle = "rgba(255,255,255,0.12)";
  ctx.fillRect(0, mid, cssWidth, 1);

  // sélection
  if (S.selection) {
    const x1 = S.selection.start * S.pxPerSec;
    const x2 = S.selection.end * S.pxPerSec;
    ctx.fillStyle = "rgba(77, 163, 255, 0.22)";
    ctx.fillRect(x1, 0, x2 - x1, cssHeight);
    ctx.strokeStyle = "#4da3ff";
    ctx.beginPath();
    ctx.moveTo(x1, 0);
    ctx.lineTo(x1, cssHeight);
    ctx.moveTo(x2, 0);
    ctx.lineTo(x2, cssHeight);
    ctx.stroke();
  }

  // tête de lecture
  const px = S.playhead * S.pxPerSec;
  ctx.fillStyle = "#ff4d4d";
  ctx.fillRect(px - 1, 0, 2, cssHeight);

  const empty = $("#waveEmpty");
  if (empty) empty.hidden = !!S.build;
  const hint = $("#waveHint");
  if (hint) {
    hint.textContent = S.build
      ? `Durée montée : ${dur.toFixed(1)} s · ${segments.filter((s) => s.tempo > 1).length} silences accélérés`
      : "Enregistre ta voix ou importe un fichier audio pour commencer.";
  }
}

export function scrollToPlayhead() {
  if (!wrap) return;
  const x = S.playhead * S.pxPerSec;
  if (x < wrap.scrollLeft + 40 || x > wrap.scrollLeft + wrap.clientWidth - 40) {
    wrap.scrollLeft = Math.max(0, x - wrap.clientWidth * 0.35);
  }
}
