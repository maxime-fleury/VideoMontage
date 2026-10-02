import { S, duration, emit, on, sourceById, allAudioClips } from "./state.js";
import { $, clamp } from "./api.js";
import { overlayAlpha, overlayGeometry } from "./geometry.js";

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
// Scène de prévisualisation : clips principaux + incrustations + textes libres.
// Le modèle de position est le même que celui du rendu (fractions 0..1 du cadre),
// donc ce que tu déplaces ici est exactement ce qui sort de l'export.
// ---------------------------------------------------------------------------

export class Stage {
  constructor(container) {
    this.container = container;
    this.elements = new Map();
    this.overlayElements = new Map();
    this.textElements = new Map();
    this.showIncrustations = true;

    on("tick", () => this.update(S.playhead));
    on("render", () => {
      this.rebuild();
      this.update(S.playhead);
    });
  }

  /** Dimensions en pixels d'un élément pointé sur le cadre réel. */
  frameSize() {
    const rect = this.container.getBoundingClientRect();
    return { width: Math.max(1, rect.width), height: Math.max(1, rect.height) };
  }

  /**
   * Le serveur renvoie une version normalisée du projet après chaque sauvegarde :
   * les objets mémorisés ici deviendraient obsolètes. On les rafraîchit par
   * identifiant avant tout affichage (sinon une modification faite juste après une
   * sauvegarde serait écrite dans le vide).
   */
  syncReferences() {
    const clips = new Map((S.project?.videoTrack || []).map((clip) => [clip.id, clip]));
    for (const [id, entry] of this.elements) {
      const fresh = clips.get(id);
      if (fresh) entry.clip = fresh;
    }
    const overlays = new Map();
    for (const layer of S.project?.overlayLayers || []) for (const clip of layer.clips) overlays.set(clip.id, clip);
    for (const [id, entry] of this.overlayElements) {
      const fresh = overlays.get(id);
      if (fresh) entry.clip = fresh;
    }
    const texts = new Map((S.project?.texts || []).map((text) => [text.id, text]));
    for (const [id, entry] of this.textElements) {
      const fresh = texts.get(id);
      if (fresh) entry.text = fresh;
    }
  }

  rebuild() {
    this.syncReferences();
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
    if (empty) empty.hidden = clips.length > 0 || (S.project?.overlayLayers || []).some((l) => l.clips.length);
    this.rebuildOverlays();
    this.rebuildTexts();
  }

  rebuildOverlays() {
    this.syncReferences();
    const layers = (S.project?.overlayLayers || []).filter((layer) => !layer.hidden);
    const wanted = new Set();
    for (const layer of layers) for (const clip of layer.clips) wanted.add(clip.id);
    for (const [id, entry] of this.overlayElements) {
      if (!wanted.has(id)) {
        entry.node.remove();
        this.overlayElements.delete(id);
      }
    }
    for (const layer of layers) {
      for (const clip of layer.clips) {
        if (this.overlayElements.has(clip.id)) continue;
        const source = sourceById(clip.sourceId);
        if (!source) continue;
        const node = document.createElement("div");
        node.className = "stage-overlay";
        let media;
        if (source.kind === "video") {
          media = document.createElement("video");
          media.src = source.url;
          media.muted = true;
          media.playsInline = true;
          media.preload = "auto";
        } else {
          media = document.createElement("img");
          media.src = source.url;
          media.loading = "lazy";
        }
        media.style.objectFit = clip.fit === "contain" ? "contain" : "cover";
        node.append(media);
        this.container.append(node);
        this.overlayElements.set(clip.id, { node, media, clip, source });
      }
    }
  }

  rebuildTexts() {
    this.syncReferences();
    const texts = S.project?.texts || [];
    const wanted = new Set(texts.map((t) => t.id));
    for (const [id, entry] of this.textElements) {
      if (!wanted.has(id)) {
        entry.node.remove();
        this.textElements.delete(id);
      }
    }
    for (const text of texts) {
      if (this.textElements.has(text.id)) continue;
      const node = document.createElement("div");
      node.className = "stage-text";
      node.dataset.textId = text.id;
      this.container.append(node);
      this.textElements.set(text.id, { node, text, dragging: null });
      wireTextDrag(this, node, text);
    }
    this.applyTextStyles();
  }

  applyTextStyles() {
    const { height } = this.frameSize();
    for (const entry of this.textElements.values()) {
      const { node, text } = entry;
      const style = text.style || {};
      const fontSize = Math.max(6, (style.size ?? 0.07) * height);
      node.style.fontFamily = `'${style.font || "Outfit"}', system-ui, sans-serif`;
      node.style.fontSize = `${fontSize}px`;
      node.style.fontWeight = style.bold ? "700" : "400";
      node.style.fontStyle = style.italic ? "italic" : "normal";
      node.style.color = style.color || "#fff";
      node.style.textAlign = style.align || "center";
      node.style.letterSpacing = `${Number(style.letterSpacing || 0) * (height / 1080)}px`;
      node.style.lineHeight = String(style.lineHeight || 1.15);
      node.style.textTransform = style.uppercase ? "uppercase" : "none";
      node.style.padding = style.background ? `${Math.max(2, (style.padding * height) / 1080 + fontSize * 0.25)}px ${fontSize * 0.6}px` : "0";
      node.style.background = style.background || "transparent";
      node.style.borderRadius = style.background ? `${Math.max(4, fontSize * 0.25)}px` : "0";
      const outline = ((style.outlineWidth || 0) * height) / 1080;
      node.style.webkitTextStroke = outline > 0.2 ? `${outline / 2}px ${style.outlineColor || "#000"}` : "";
      const shadow = ((style.shadow || 0) * height) / 1080;
      const shadows = [];
      if (shadow > 0.3) shadows.push(`0 ${shadow / 2}px ${shadow}px rgba(0,0,0,0.55)`);
      if (outline > 0.2) {
        const o = outline;
        shadows.push(`-${o}px 0 ${style.outlineColor}`, `${o}px 0 ${style.outlineColor}`, `0 -${o}px ${style.outlineColor}`, `0 ${o}px ${style.outlineColor}`);
      }
      node.style.textShadow = shadows.join(", ");
    }
  }

  /** Position et opacité d'un texte à un instant donné (anime entrée/sortie). */
  updateTexts(t) {
    const { height } = this.frameSize();
    for (const entry of this.textElements.values()) {
      const { node, text } = entry;
      const local = t - text.start;
      const active = local >= -0.001 && local <= text.duration;
      if (!active) {
        node.style.display = "none";
        continue;
      }
      node.style.display = "block";
      const box = text.box;
      const animation = text.animation || {};
      const animDuration = Math.max(0.05, Math.min(animation.duration || 0.35, text.duration / 2));
      let alpha = 1;
      let scale = 1;
      let dx = 0;
      let dy = 0;
      const progressIn = clamp(local / animDuration, 0, 1);
      const outProgress = clamp((text.duration - local) / animDuration, 0, 1);
      switch (animation.in) {
        case "fade":
          alpha = progressIn;
          break;
        case "pop":
          alpha = progressIn;
          scale = 0.6 + 0.4 * progressIn;
          break;
        case "slide-up":
          dy = (1 - progressIn) * 0.06;
          alpha = progressIn;
          break;
        case "slide-down":
          dy = -(1 - progressIn) * 0.06;
          alpha = progressIn;
          break;
        case "slide-left":
          dx = (1 - progressIn) * 0.08;
          alpha = progressIn;
          break;
        case "slide-right":
          dx = -(1 - progressIn) * 0.08;
          alpha = progressIn;
          break;
        default:
          break;
      }
      switch (animation.out) {
        case "fade":
          alpha = Math.min(alpha, outProgress);
          break;
        case "pop":
          alpha = Math.min(alpha, outProgress);
          scale *= 0.9 + 0.1 * outProgress;
          break;
        case "slide":
          dy += (1 - outProgress) * 0.04;
          alpha = Math.min(alpha, outProgress);
          break;
        default:
          break;
      }

      const left = clamp(box.x + dx, -1, 1.5);
      const top = clamp(box.y + dy, -1, 1.5);
      node.style.left = `${left * 100}%`;
      node.style.top = `${top * 100}%`;
      node.style.width = `${box.w * 100}%`;
      node.style.minHeight = `${box.h * 100}%`;
      node.style.opacity = String(clamp(alpha, 0, 1));
      const rotate = text.rotation ? `rotate(${text.rotation}deg)` : "";
      node.style.transform = `${rotate} scale(${scale.toFixed(3)})`.trim();
      node.style.zIndex = String(6 + (text.z || 0));
      node.style.pointerEvents = this.showIncrustations ? "auto" : "none";

      // Machine à écrire et surlignage mot par mot.
      const content = text.style?.uppercase ? (text.text || "").toUpperCase() : text.text || "";
      if (animation.in === "typewriter") {
        const shown = Math.max(1, Math.ceil(content.length * clamp(local / (text.duration * 0.7), 0, 1)));
        node.textContent = content.slice(0, shown);
      } else if (animation.in === "word-highlight") {
        const words = content.split(/\s+/);
        const index = Math.floor(clamp(local / Math.max(0.05, text.duration), 0, 0.999) * words.length);
        node.innerHTML = "";
        words.forEach((word, i) => {
          const span = document.createElement("span");
          span.textContent = `${word} `;
          if (i <= index) span.style.color = text.style?.highlightColor || "#ffd166";
          node.append(span);
        });
      } else if (node.textContent !== content) {
        node.textContent = content;
      }
      node.classList.toggle("selected", S.selectedTextId === text.id);
    }
  }

  updateOverlays(t) {
    for (const entry of this.overlayElements.values()) {
      const { node, media, clip } = entry;
      const local = t - clip.start;
      const active = this.showIncrustations && local >= -0.001 && local <= clip.duration;
      if (!active) {
        node.style.display = "none";
        if (media.tagName === "VIDEO" && !media.paused) media.pause();
        continue;
      }
      node.style.display = "block";
      const geometry = overlayGeometry(clip, local, S.motions);
      node.style.left = `${geometry.x * 100}%`;
      node.style.top = `${geometry.y * 100}%`;
      node.style.width = `${geometry.w * 100}%`;
      node.style.height = `${geometry.h * 100}%`;
      node.style.opacity = String(overlayAlpha(clip, local));
      node.style.transform = clip.rotation ? `rotate(${clip.rotation}deg)` : "";
      node.style.zIndex = String(4 + (clip.layerZ || 0));
      if (media.tagName === "VIDEO") {
        const expected = (clip.offset || 0) + Math.max(0, local);
        if (Math.abs(media.currentTime - expected) > 0.35) media.currentTime = Math.max(0, expected);
        if (media.paused) media.play().catch(() => {});
      }
    }
  }

  update(t) {
    this.syncReferences();
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
    this.updateOverlays(t);
    this.updateTexts(t);
  }
}

/** Déplacement d'un texte à la souris, directement sur l'aperçu. */
function wireTextDrag(stage, node, text) {
  const handle = document.createElement("div");
  handle.className = "text-handle corner";
  handle.title = "Glisser pour changer la taille du texte";
  const rotate = document.createElement("div");
  rotate.className = "text-handle rotate";
  rotate.title = "Glisser pour faire pivoter";
  node.append(handle, rotate);

  const begin = (event, mode) => {
    event.preventDefault();
    event.stopPropagation();
    S.selectedTextId = text.id;
    emit("selection-clip", { id: text.id, kind: "text", ids: [text.id] });
    const rect = stage.container.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    // Le texte peut avoir été remplacé par une réponse du serveur : on retrouve
    // l'objet courant à chaque geste.
    const live = () => (S.project?.texts || []).find((item) => item.id === text.id) || text;
    const target = live();
    const origin = { x: target.box.x, y: target.box.y, w: target.box.w, size: target.style.size, rotation: target.rotation || 0 };
    node.classList.add("dragging");
    let moved = false;

    const move = (e) => {
      const text = live();
      const dx = (e.clientX - startX) / rect.width;
      const dy = (e.clientY - startY) / rect.height;
      moved = true;
      if (mode === "move") {
        text.box.x = clamp(origin.x + dx, -0.5, 1.2);
        text.box.y = clamp(origin.y + dy, -0.5, 1.2);
        // Aimants : centre, bords et tiers (Alt pour désactiver).
        if (!e.altKey) {
          const snap = (value, targets) => {
            for (const target of targets) if (Math.abs(value - target) < 0.012) return target;
            return value;
          };
          text.box.x = snap(text.box.x, [0, 0.1, 0.5 - text.box.w / 2, 0.5, 0.9 - text.box.w, 1 - text.box.w]);
          text.box.y = snap(text.box.y, [0, 0.05, 0.5 - text.box.h / 2, 0.5, 0.2]);
        }
      } else if (mode === "resize") {
        const factor = clamp(1 + dx * 1.6 + dy * 1.6, 0.4, 3);
        text.style.size = clamp(origin.size * factor, 0.015, 0.5);
        text.box.w = clamp(origin.w * clamp(1 + dx, 0.3, 2.2), 0.1, 1.6);
      } else if (mode === "rotate") {
        const centerX = rect.width * (text.box.x + text.box.w / 2);
        const centerY = rect.height * (text.box.y + text.box.h / 2);
        const angle = (Math.atan2(e.clientY - rect.top - centerY, e.clientX - rect.left - centerX) * 180) / Math.PI + 90;
        text.rotation = clamp(Math.round(angle / 2) * 2, -180, 180);
      }
      stage.applyTextStyles();
      stage.update(S.playhead);
      emit("dragging");
    };
    const up = () => {
      node.classList.remove("dragging");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (moved) {
        emit("persist");
        emit("render");
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  node.addEventListener("pointerdown", (event) => {
    if (event.target === handle || event.target === rotate) return;
    begin(event, "move");
  });
  handle.addEventListener("pointerdown", (event) => begin(event, "resize"));
  rotate.addEventListener("pointerdown", (event) => begin(event, "rotate"));
  node.addEventListener("dblclick", (event) => {
    event.stopPropagation();
    emit("edit-text", { id: text.id });
  });
}
