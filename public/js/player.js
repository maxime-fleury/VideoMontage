import { S, duration, emit, on, sourceById, allAudioClips } from "./state.js";
import { $, clamp } from "./api.js";

// ---------------------------------------------------------------------------
// Lecture audio : la voix compilée sert d'horloge, les autres pistes sont
// programmées dans la Web Audio API.
// ---------------------------------------------------------------------------
export class Player {
  constructor() {
    this.voice = new Audio();
    this.voice.preload = "auto";
    this.ctx = null;
    this.buffers = new Map();
    this.nodes = [];
    this.raf = null;
    this.voice.addEventListener("ended", () => this.stop());
  }

  setSource(url) {
    if (!url) return;
    if (this.voice.src !== new URL(url, location.href).href) {
      const wasPlaying = S.playing;
      this.voice.src = url;
      if (wasPlaying) this.play();
    }
  }

  async ensureCtx() {
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === "suspended") await this.ctx.resume();
    return this.ctx;
  }

  async loadBuffer(url) {
    if (this.buffers.has(url)) return this.buffers.get(url);
    const promise = (async () => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Audio ${res.status}`);
      const data = await res.arrayBuffer();
      const ctx = await this.ensureCtx();
      return await ctx.decodeAudioData(data);
    })();
    this.buffers.set(url, promise);
    return promise;
  }

  async play() {
    if (!S.build) return;
    if (S.playhead >= duration() - 0.05) S.playhead = 0;
    this.voice.currentTime = S.playhead;
    try {
      await this.voice.play();
    } catch (e) {
      console.warn("Lecture impossible", e);
      return;
    }
    S.playing = true;
    emit("playing");
    await this.scheduleOverlays();
    this.tick();
  }

  stop() {
    this.voice.pause();
    this.voice.currentTime = S.playhead;
    S.playing = false;
    this.clearOverlays();
    emit("playing");
    emit("tick");
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = null;
  }

  pause() {
    this.stop();
  }

  seek(t) {
    S.playhead = clamp(t, 0, duration());
    this.voice.currentTime = S.playhead;
    if (S.playing) {
      this.clearOverlays();
      this.scheduleOverlays();
    }
    emit("tick");
  }

  clearOverlays() {
    for (const entry of this.nodes) {
      try {
        entry.node.stop();
      } catch {}
      try {
        entry.node.disconnect();
        entry.gain?.disconnect();
      } catch {}
    }
    this.nodes = [];
  }

  async scheduleOverlays() {
    const t0 = S.playhead;
    const entries = allAudioClips().filter(({ track, clip }) => {
      if (track.muted) return false;
      return clip.start + clip.duration > t0 + 0.02;
    });
    if (!entries.length) return;
    let ctx;
    try {
      ctx = await this.ensureCtx();
    } catch {
      return;
    }
    const origin = ctx.currentTime + 0.08;
    for (const { track, clip } of entries) {
      const source = sourceById(clip.sourceId);
      if (!source) continue;
      let buffer;
      try {
        buffer = await this.loadBuffer(source.url);
      } catch {
        continue;
      }
      const startInTimeline = Math.max(clip.start, t0);
      const localStart = startInTimeline - clip.start;
      const dur = clip.duration - localStart;
      if (dur <= 0.03) continue;
      const offset = clip.offset + localStart;
      if (!clip.loop && offset >= buffer.duration) continue;

      const node = ctx.createBufferSource();
      node.buffer = buffer;
      if (clip.loop) node.loop = true;
      const gain = ctx.createGain();
      const base = clamp(clip.gain ?? 1, 0, 4);
      const when = origin + (startInTimeline - t0);
      const fadeIn = clamp(clip.fadeIn ?? 0, 0, dur);
      const fadeOut = clamp(clip.fadeOut ?? 0, 0, dur);
      gain.gain.setValueAtTime(base, when);
      if (fadeIn > 0.02 && localStart < fadeIn) {
        gain.gain.setValueAtTime((base * localStart) / fadeIn, when);
        gain.gain.linearRampToValueAtTime(base, when + (fadeIn - localStart));
      }
      const fadeOutStart = clip.duration - fadeOut;
      if (fadeOut > 0.02 && localStart < fadeOutStart) {
        gain.gain.setValueAtTime(base, when + (fadeOutStart - localStart));
        gain.gain.linearRampToValueAtTime(0.0001, when + (clip.duration - localStart));
      }
      node.connect(gain).connect(ctx.destination);
      try {
        node.start(when, Math.max(0, Math.min(offset, Math.max(0, buffer.duration - 0.01))), dur);
      } catch {
        continue;
      }
      this.nodes.push({ node, gain, clip, track });
    }
  }

  tick() {
    if (!S.playing) return;
    S.playhead = Math.min(this.voice.currentTime, duration());
    emit("tick");
    if (S.playhead >= duration() - 0.03) {
      this.stop();
      return;
    }
    this.raf = requestAnimationFrame(() => this.tick());
  }
}

// ---------------------------------------------------------------------------
// Scène de prévisualisation: images/vidéos empilées avec fondus
// ---------------------------------------------------------------------------
export class Stage {
  constructor(container) {
    this.container = container;
    this.elements = new Map();
  }

  rebuild() {
    const clips = S.project?.videoTrack || [];
    const wanted = new Set(clips.map((c) => c.id));
    for (const [id, entry] of this.elements) {
      if (!wanted.has(id)) {
        entry.node.remove();
        this.elements.delete(id);
      }
    }
    for (const clip of clips) {
      if (this.elements.has(clip.id)) continue;
      const source = sourceById(clip.sourceId);
      if (!source) continue;
      let node;
      if (source.kind === "video") {
        node = document.createElement("video");
        node.src = source.url;
        node.muted = true;
        node.playsInline = true;
        node.preload = "auto";
      } else {
        node = document.createElement("img");
        node.src = source.url;
        node.loading = "lazy";
      }
      node.className = "stage-clip";
      this.container.append(node);
      this.elements.set(clip.id, { node, clip, source });
    }
    const empty = $("#stageEmpty");
    if (empty) empty.hidden = clips.length > 0;
  }

  update(t) {
    const clipList = (S.project?.videoTrack || []).slice().sort((a, b) => a.start - b.start);
    for (const clip of clipList) {
      const entry = this.elements.get(clip.id);
      if (!entry) continue;
      const { node } = entry;
      const local = t - clip.start;
      const active = local >= 0 && local <= clip.duration;
      if (!active) {
        node.style.opacity = "0";
        if (node.tagName === "VIDEO" && !node.paused) node.pause();
        continue;
      }
      const fadeIn = clamp(clip.effect?.fadeIn ?? 0, 0, clip.duration / 2);
      const fadeOut = clamp(clip.effect?.fadeOut ?? 0, 0, clip.duration / 2);
      let alpha = 1;
      if (fadeIn > 0.02 && local < fadeIn) alpha = local / fadeIn;
      const fadeOutStart = clip.duration - fadeOut;
      if (fadeOut > 0.02 && local > fadeOutStart) alpha = Math.min(alpha, (clip.duration - local) / fadeOut);
      node.style.opacity = String(clamp(alpha, 0, 1));
      if (clip.effect?.kenBurns) {
        const z0 = clip.effect.zoomFrom || 1;
        const z1 = clip.effect.zoomTo || 1.1;
        const progress = clamp(local / clip.duration, 0, 1);
        node.style.transform = `scale(${(z0 + (z1 - z0) * progress).toFixed(4)})`;
      } else if (node.style.transform) {
        node.style.transform = "";
      }
      if (node.tagName === "VIDEO") {
        const expected = clip.offset + local;
        if (Math.abs(node.currentTime - expected) > 0.35) node.currentTime = Math.max(0, expected);
        if (node.paused) node.play().catch(() => {});
      }
    }
  }
}
