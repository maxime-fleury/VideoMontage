import { S, duration, emit, on, sourceById, allAudioClips } from "./state.js";
import { $, clamp, newId } from "./api.js";
import { overlayAlpha, overlayGeometry } from "./geometry.js";
import { hasKeyframes, keyframeAt, keyframeCenter, MAX_KEYFRAMES } from "./keyframes.js";
import { applyChroma, canvasSize, contentRect, rgbToHex } from "./chroma.js";

/** Résolution de travail du canvas de clé chromatique (aperçu fluide). */
const CHROMA_MAX_SIDE = 480;
/** Résolution d'échantillonnage de la pipette (précision suffisante, instantané). */
const PICK_MAX_SIDE = 720;
/** Écart maximal (s) pour considérer qu'une image clé est « celle qu'on règle ». */
const KEYFRAME_TOUCH = 0.3;

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

    on("pick-color", (payload = {}) => this.startPick(payload));

    // Tracé du déplacement : on suit l'incrustation dont l'éditeur est ouvert ou
    // qui vient d'être sélectionnée dans la timeline.
    on("selection-clip", ({ id, kind } = {}) => {
      S.overlayPathClipId = kind === "overlay" ? id : null;
      this.updateMotionPath(S.playhead);
    });
    on("edit-overlay", ({ clipId }) => {
      S.overlayPathClipId = clipId || null;
      this.updateMotionPath(S.playhead);
    });

    // Pipette de la clé chromatique : un clic sur un média d'incrustation renvoie
    // la couleur du pixel exact (avant traitement), Échap annule.
    this.container.addEventListener("pointerdown", (event) => {
      if (!this.picking) return;
      event.preventDefault();
      event.stopPropagation();
      this.handlePick(event);
    }, true);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.picking) this.cancelPick();
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
        if (this.overlayElements.has(clip.id)) {
          const entry = this.overlayElements.get(clip.id);
          entry.clip = clip;
          entry.source = sourceById(clip.sourceId) || entry.source;
          this.syncOverlayMedia(entry);
          continue;
        }
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
        const entry = { node, media, clip, source, canvas: null, ctx: null };
        this.overlayElements.set(clip.id, entry);
        this.syncOverlayMedia(entry);
        wireOverlayDrag(this, entry);
      }
    }
  }

  /**
   * Le canvas de clé chromatique n'existe que lorsque le média en a besoin : on
   * l'ajoute/le retire au fil des réglages, sans reconstruire l'incrustation.
   */
  syncOverlayMedia(entry) {
    const { node, media, clip, source } = entry;
    const fit = clip.fit === "contain" ? "contain" : "cover";
    media.style.objectFit = fit;
    const chroma = source?.chroma;
    const wanted = !!chroma?.enabled;
    node.classList.toggle("chroma", wanted);
    if (wanted && !entry.canvas) {
      const canvas = document.createElement("canvas");
      canvas.className = "chroma-canvas";
      canvas.style.objectFit = fit;
      node.append(canvas);
      entry.canvas = canvas;
      entry.ctx = null;
      entry.stamp = null;
      entry.drawnAt = 0;
      this.drawChroma(entry, true);
      return;
    }
    if (!wanted && entry.canvas) {
      entry.canvas.remove();
      entry.canvas = null;
      entry.ctx = null;
      entry.stamp = null;
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
      node.style.transform = geometry.rotation ? `rotate(${geometry.rotation}deg)` : "";
      node.style.zIndex = String(4 + (clip.layerZ || 0));
      node.style.pointerEvents = "auto";
      node.classList.toggle("selected", S.selectedClipId === clip.id && S.selectedClipKind === "overlay");
      ensureOverlayHandles(entry);
      if (media.tagName === "VIDEO") {
        const expected = (clip.offset || 0) + Math.max(0, local);
        if (Math.abs(media.currentTime - expected) > 0.35) media.currentTime = Math.max(0, expected);
        if (media.paused) media.play().catch(() => {});
      }
      if (entry.canvas) this.drawChroma(entry);
    }
  }

  /**
   * Aperçu fidèle de la transparence : le média est redessiné dans un canvas où
   * l'on applique les mêmes formules que `colorkey` et `despill` (module chroma.js).
   * Le canvas respecte `object-fit`, donc le cadrage est celui du rendu.
   */
  drawChroma(entry, force = false) {
    const { media, canvas, source } = entry;
    const chroma = source?.chroma;
    if (!canvas || !chroma?.enabled) return;
    const naturalW = media.videoWidth || media.naturalWidth || 0;
    const naturalH = media.videoHeight || media.naturalHeight || 0;
    if (!naturalW || !naturalH) return;
    const size = canvasSize(naturalW, naturalH, CHROMA_MAX_SIDE);
    if (canvas.width !== size.width || canvas.height !== size.height) {
      canvas.width = size.width;
      canvas.height = size.height;
      entry.ctx = null;
      force = true;
    }
    // Pas encore de flux décodé (métadonnées seules, saut de la tête de lecture) :
    // redessiner viderait le canvas et ferait clignoter la transparence. On
    // redessine dès que le média est prêt, même si la lecture est en pause.
    const ready = media.tagName === "VIDEO" ? media.readyState >= 2 : !!media.naturalWidth;
    if (!ready) {
      this.redrawWhenReady(entry, media);
      return;
    }
    const stamp = `${chroma.color}|${chroma.similarity}|${chroma.blend}|${chroma.despill}`;
    const now = performance.now();
    // Une image ne change pas : on ne la retraite que si les réglages ont bougé.
    // Une vidéo doit être retraitée à chaque nouveau flux (≈ 30 img/s au maximum).
    if (!force && entry.stamp === stamp) {
      if (media.tagName !== "VIDEO" || now - (entry.drawnAt || 0) < 1000 / 30) return;
    }
    entry.ctx = entry.ctx || canvas.getContext("2d", { willReadFrequently: true });
    const ctx = entry.ctx;
    if (!ctx) return;
    try {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(media, 0, 0, canvas.width, canvas.height);
    } catch {
      return;
    }
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    ctx.putImageData(applyChroma(image, chroma), 0, 0);
    entry.stamp = stamp;
    entry.drawnAt = now;
  }

  /** Redessine le canvas dès que le média a des pixels (une seule fois). */
  redrawWhenReady(entry, media) {
    if (entry.pendingDraw) return;
    entry.pendingDraw = true;
    const events = media.tagName === "VIDEO" ? ["loadeddata", "seeked", "canplay"] : ["load", "error"];
    const redraw = () => {
      entry.pendingDraw = false;
      for (const event of events) media.removeEventListener(event, redraw);
      this.drawChroma(entry, true);
    };
    for (const event of events) media.addEventListener(event, redraw, { once: true });
  }

  /**
   * Couleur du média sous le curseur — la pipette de la clé chromatique.
   * Renvoie { sourceId, color } ou null si aucun média d'incrustation n'est là.
   */
  sampleColorAt(clientX, clientY) {
    const entries = [...this.overlayElements.values()].sort((a, b) => (a.clip.layerZ || 0) - (b.clip.layerZ || 0));
    for (const entry of entries.reverse()) {
      const { node, media, clip } = entry;
      if (node.style.display === "none") continue;
      const rect = node.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) continue;
      const naturalW = media.videoWidth || media.naturalWidth || 0;
      const naturalH = media.videoHeight || media.naturalHeight || 0;
      if (!naturalW || !naturalH) continue;
      const content = contentRect(naturalW, naturalH, rect.width, rect.height, clip.fit);
      const x = clientX - rect.left - content.left;
      const y = clientY - rect.top - content.top;
      if (x < 0 || y < 0 || x > content.width || y > content.height) continue;
      const size = canvasSize(naturalW, naturalH, PICK_MAX_SIDE);
      const canvas = document.createElement("canvas");
      canvas.width = size.width;
      canvas.height = size.height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      try {
        ctx.drawImage(media, 0, 0, size.width, size.height);
        const px = Math.min(size.width - 1, Math.floor((x / content.width) * size.width));
        const py = Math.min(size.height - 1, Math.floor((y / content.height) * size.height));
        const data = ctx.getImageData(px, py, 1, 1).data;
        return { sourceId: clip.sourceId, clipId: clip.id, color: rgbToHex({ r: data[0], g: data[1], b: data[2] }) };
      } catch {
        return null;
      }
    }
    return null;
  }

  /** Active la pipette : le prochain clic sur l'aperçu renvoie une couleur. */
  startPick({ sourceId, clipId }) {
    this.picking = { sourceId, clipId };
    this.container.classList.add("picking");
  }

  cancelPick() {
    if (!this.picking) return;
    this.picking = null;
    this.container.classList.remove("picking");
    emit("pick-cancelled");
  }

  handlePick(event) {
    const picked = this.sampleColorAt(event.clientX, event.clientY);
    if (!picked) {
      emit("pick-missed");
      return;
    }
    this.picking = null;
    this.container.classList.remove("picking");
    // La couleur va au média pointé (WYSIWYG) : c'est celui dont l'éditeur se rouvre.
    emit("color-picked", { ...picked });
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
    this.updateMotionPath(t);
    this.updateTexts(t);
  }

  /**
   * Tracé du déplacement d'une incrustation animée : la trajectoire entre les
   * images clés, jalonnée de pastilles numérotées. C'est le même centre que
   * celui utilisé par le rendu (`cx`/`cy` = case + moitié de la taille), donc le
   * dessin tombe exactement sur le chemin exporté.
   *
   * Un clic sur une pastille amène la tête de lecture sur son image clé ; la
   * pastille courante est mise en évidence pendant la lecture.
   */
  updateMotionPath(t) {
    const clip = (S.project?.overlayLayers || [])
      .flatMap((layer) => layer.clips || [])
      .find((item) => item.id === S.overlayPathClipId);
    const keys = clip && hasKeyframes(clip) ? [...clip.keys].sort((a, b) => a.t - b.t) : [];
    const visible = !!clip && keys.length > 1 && S.showMotionPath !== false && this.showIncrustations;
    if (!visible) {
      if (this.pathLayer) this.pathLayer.svg.style.display = "none";
      this.pathSignature = null;
      return;
    }
    const layer = this.ensurePathLayer();
    layer.svg.style.display = "block";
    const { width, height } = this.frameSize();
    const signature = `${clip.id}|${width.toFixed(1)}x${height.toFixed(1)}|${keys
      .map((key) => `${key.t.toFixed(3)}:${key.box.x.toFixed(4)},${key.box.y.toFixed(4)},${key.box.w.toFixed(4)},${key.box.h.toFixed(4)}`)
      .join(";")}`;
    if (signature === this.pathSignature) {
      this.highlightPathKey(clip, keys, t);
      return;
    }
    this.pathSignature = signature;
    layer.svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    const points = keys.map((key) => {
      const center = keyframeCenter(key, clip.box);
      return { x: center.x * width, y: center.y * height, key, center };
    });
    layer.line.setAttribute("points", points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" "));
    layer.marks.innerHTML = "";
    layer.dots = points.map((point, index) => {
      const dot = document.createElement("button");
      dot.className = "stage-path-dot";
      dot.type = "button";
      dot.textContent = String(index + 1);
      dot.title = `Image clé ${index + 1} · ${point.key.t.toFixed(2)} s — cliquer pour y aller`;
      dot.style.left = `${point.center.x * 100}%`;
      dot.style.top = `${point.center.y * 100}%`;
      dot.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        S.overlayPathClipId = clip.id;
        emit("seek", Math.max(0, clip.start + point.key.t));
      });
      layer.marks.append(dot);
      return dot;
    });
    this.highlightPathKey(clip, keys, t);
  }

  highlightPathKey(clip, keys, t) {
    const layer = this.pathLayer;
    if (!layer?.dots) return;
    const local = clamp(t - clip.start, 0, clip.duration);
    const current = keyframeAt(clip, local, 0.05);
    layer.dots.forEach((dot, index) => dot.classList.toggle("current", current === keys[index]));
  }

  ensurePathLayer() {
    if (this.pathLayer) return this.pathLayer;
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("class", "stage-path");
    const line = document.createElementNS(ns, "polyline");
    line.setAttribute("class", "stage-path-line");
    svg.append(line);
    const marks = document.createElement("div");
    marks.className = "stage-path-marks";
    this.container.append(svg, marks);
    this.pathLayer = { svg, line, marks, dots: [] };
    return this.pathLayer;
  }
}

/** Incrustation vivante : les sauvegardes remplacent les objets du projet. */
function liveOverlay(clipId) {
  for (const layer of S.project?.overlayLayers || []) {
    const found = layer.clips.find((clip) => clip.id === clipId);
    if (found) return found;
  }
  return null;
}

/** État complet (cadre, rotation, opacité) d'une incrustation à un instant local. */
function overlayStateAt(clip, local) {
  const geometry = overlayGeometry(clip, local, S.motions);
  return {
    box: { x: geometry.x, y: geometry.y, w: geometry.w, h: geometry.h },
    rotation: Number(geometry.rotation) || 0,
    opacity: overlayAlpha(clip, local),
  };
}

/**
 * Poignées d'images clés : elles n'apparaissent que sur une incrustation
 * animée, et servent à régler l'image clé courante au glisser.
 */
function ensureOverlayHandles(entry) {
  const keyframed = hasKeyframes(entry.clip);
  if (keyframed && !entry.handles) {
    const resize = document.createElement("div");
    resize.className = "overlay-handle corner";
    resize.title = "Glisser pour changer la taille de l'image clé";
    const rotate = document.createElement("div");
    rotate.className = "overlay-handle rotate";
    rotate.title = "Glisser pour faire pivoter l'image clé";
    entry.node.append(resize, rotate);
    entry.handles = { resize, rotate };
  } else if (!keyframed && entry.handles) {
    for (const handle of Object.values(entry.handles)) handle.remove();
    entry.handles = null;
  }
}

/**
 * Glisser une incrustation sur l'aperçu.
 *
 * Sur une incrustation à images clés, le geste règle **l'image clé courante** :
 * celle qui est à la tête de lecture, ou, s'il n'y en a pas, une nouvelle image clé
 * posée exactement là où l'on se trouve (c'est le geste naturel « je la place ici »).
 * Sur une incrustation sans image clé, le geste modifie directement sa case.
 */
function wireOverlayDrag(stage, entry) {
  const begin = (event, mode) => {
    event.preventDefault();
    event.stopPropagation();
    const clip = liveOverlay(entry.clip.id) || entry.clip;
    S.selectedClipId = clip.id;
    S.selectedClipKind = "overlay";
    S.selectedClipIds = [clip.id];
    emit("selection-clip", { id: clip.id, kind: "overlay", ids: [clip.id] });

    const rect = stage.container.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const local = clamp(S.playhead - clip.start, 0, clip.duration);
    const state = overlayStateAt(clip, local);
    const origin = { box: { ...state.box }, rotation: state.rotation, opacity: state.opacity };
    // image clé visée (null = à créer au premier mouvement)
    let target = hasKeyframes(clip) ? keyframeAt(clip, local, KEYFRAME_TOUCH) : clip;
    let moved = false;

    const pointer = (e) => ({
      x: (e.clientX - rect.left) / rect.width,
      y: (e.clientY - rect.top) / rect.height,
    });
    const startPointer = pointer(event);
    const center = { x: origin.box.x + origin.box.w / 2, y: origin.box.y + origin.box.h / 2 };
    const grab = { x: center.x - startPointer.x, y: center.y - startPointer.y };
    const grabDistance = Math.max(0.02, Math.hypot(startPointer.x - center.x, startPointer.y - center.y));

    const ensureTarget = () => {
      if (target) return;
      const keys = clip.keys || [];
      if (keys.length >= MAX_KEYFRAMES) {
        // déjà au maximum : on règle la plus proche plutôt que d'en perdre une
        target = keys.reduce((best, key) => (!best || Math.abs(key.t - local) < Math.abs(best.t - local) ? key : best), null) || clip;
        return;
      }
      target = { id: newId("kf"), t: Number(local.toFixed(3)), box: { ...origin.box }, rotation: origin.rotation, opacity: origin.opacity };
      clip.keys = [...keys, target].sort((a, b) => a.t - b.t);
    };

    const write = (patch) => {
      const writeTo = (holder) => {
        if (patch.box) holder.box = patch.box;
        if (patch.rotation !== undefined) holder.rotation = patch.rotation;
        if (patch.opacity !== undefined) holder.opacity = patch.opacity;
      };
      writeTo(target === clip ? clip : target);
      stage.update(S.playhead);
      emit("overlay-touched", { clipId: clip.id });
    };

    const snap = (value) => {
      for (const guide of [0.5, 1 / 3, 2 / 3]) if (Math.abs(value - guide) < 0.012) return guide;
      return value;
    };

    entry.node.classList.add("dragging");
    const move = (e) => {
      moved = true;
      ensureTarget();
      const point = pointer(e);
      if (mode === "move") {
        let cx = point.x + grab.x;
        let cy = point.y + grab.y;
        if (!e.altKey) {
          cx = snap(cx);
          cy = snap(cy);
        }
        cx = clamp(cx, -0.25, 1.25);
        cy = clamp(cy, -0.25, 1.25);
        write({ box: { x: cx - origin.box.w / 2, y: cy - origin.box.h / 2, w: origin.box.w, h: origin.box.h } });
      } else if (mode === "resize") {
        const distance = Math.hypot(point.x - center.x, point.y - center.y);
        const factor = clamp(distance / grabDistance, 0.12, 5);
        const w = clamp(origin.box.w * factor, 0.02, 2);
        const h = clamp(origin.box.h * factor, 0.02, 2);
        write({ box: { x: center.x - w / 2, y: center.y - h / 2, w, h } });
      } else {
        const angle = (Math.atan2(point.y - center.y, point.x - center.x) * 180) / Math.PI + 90;
        write({ rotation: clamp(e.altKey ? angle : Math.round(angle / 15) * 15, -180, 180) });
      }
    };
    const up = () => {
      entry.node.classList.remove("dragging");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (!moved) return;
      emit("persist");
      emit("render");
      emit("overlay-touched", { clipId: clip.id, done: true });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  entry.node.addEventListener("pointerdown", (event) => {
    const mode = event.target === entry.handles?.resize
      ? "resize"
      : event.target === entry.handles?.rotate
        ? "rotate"
        : "move";
    begin(event, mode);
  });
  entry.node.addEventListener("dblclick", (event) => {
    event.stopPropagation();
    emit("edit-overlay", { clipId: entry.clip.id });
  });
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
