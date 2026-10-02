import fs from "node:fs/promises";
import path from "node:path";
import {
  DATA_DIR,
  MODELS_DIR,
  badRequest,
  buildDir,
  clamp,
  ensureDir,
  json,
  mediaDir,
  newId,
  projectDir,
  sanitizeText,
  slug,
} from "./lib/util";
import {
  createJob,
  failJob,
  finishJob,
  getJob,
  jobEventStream,
  listJobs,
  updateJob,
} from "./lib/jobs";
import {
  createProject,
  defaultEdits,
  deleteSourceFile,
  ensureProjectDirs,
  getProject,
  listProjects,
  montageDuration,
  saveProject,
  sourcePath,
  type AudioTrack,
  type Project,
  type Source,
  type VideoClip,
} from "./lib/store";
import {
  buildSegments,
  compileVoice,
  detectSilences,
  ffmpegAvailable,
  mapOutToSource,
  measureRegion,
  mergeRanges,
  probe,
  renderMontage,
} from "./lib/ffmpeg";
import { installRnnoise, installWhisper, transcribe, whisperStatus } from "./lib/whisper";
import { downloadImage, proxyImage, searchImages } from "./lib/images";
import { editImage } from "./lib/imageEdit";
import { SUBTITLE_PRESETS, defaultSubtitles, subtitleLines } from "./lib/subtitles";
import { FONTS_DIR, FONT_TTF_DIR, installFont, installRecommendedFonts, listFonts } from "./lib/fonts";
import { defaultEffect } from "./lib/store";

const NAME = "Montage Video";
const MIN_PORT = 3000;
const MAX_PORT = 3600;
const PUBLIC_DIR = "public";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readBody<T = any>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    return {} as T;
  }
}

function serialize(project: Project) {
  return {
    ...project,
    sources: project.sources.map((s) => ({ ...s, url: `/media/${project.id}/${encodeURIComponent(s.file)}` })),
    voice: {
      ...project.voice,
      build: project.voice.build
        ? {
            ...project.voice.build,
            audioUrl: `/media/${project.id}/${encodeURIComponent(project.voice.build.audioFile)}?v=${project.voice.build.builtAt}`,
          }
        : undefined,
    },
    montage: montageDuration(project),
  };
}

/** Compile la voix et enregistre. Renvoie le projet + éventuellement une erreur non bloquante. */
async function recompile(project: Project, warnings: string[] = []) {
  if (!project.voice.sourceId) return;
  try {
    const build = await compileVoice(project);
    project.voice.build = build;
    // la transcription ne correspond plus au nouveau montage
    if (project.transcript && project.transcript.hash !== build.hash) {
      warnings.push("La transcription date d'avant tes dernières modifications — relance-la si besoin.");
    }
    await saveProject(project);
  } catch (e) {
    warnings.push(e instanceof Error ? e.message : String(e));
  }
}

async function serveStatic(rel: string) {
  const safe = rel.replace(/\.\./g, "").replace(/^\/+/, "");
  const filePath = path.join(PUBLIC_DIR, safe);
  const file = Bun.file(filePath);
  if (!(await file.exists())) return new Response("Introuvable", { status: 404 });
  return new Response(file);
}

async function serveProjectFile(pid: string, file: string) {
  const safe = path.basename(file);
  const candidates = [`${buildDir(pid)}/${safe}`, `${mediaDir(pid)}/${safe}`];
  for (const c of candidates) {
    const f = Bun.file(c);
    if (await f.exists()) {
      const headers: Record<string, string> = {};
      if (safe.endsWith(".mp4")) headers["content-type"] = "video/mp4";
      return new Response(f, { headers });
    }
  }
  return new Response("Fichier introuvable", { status: 404 });
}

const STOPWORDS = new Set(
  `néanmoins effectivement également ensuite enfin puis bref voici voilà lorsque lorsqu jusqu jusque malgré selon hélas auprès environ presque toujours jamais souvent parfois plutôt vraiment seulement encore aussi autant tant tellement trop peu beaucoup moins davantage ainsi alors donc car or ni mais ou et quand comment pourquoi combien quel quelle quels quelles lequel laquelle lesquels lesquelles celui celle ceux celles ceci cela ça ce cet cette ces mon ma mes ton ta tes son sa ses notre nos votre vos leur leurs moi toi lui elle nous vous eux elles qui que quoi dont où y en le la les un une des du de à au aux par pour sans sous sur dans avec chez vers entre depuis pendant après avant contre hors suivant hormis alors au aucun aussi autre aux avais avait avant avec avoir bon car ce ceci cela celle celles celui cependant certain certaine ces cet cette ceux chaque chez comme comment des dedans dehors devait devrait deux doit donc dos droite déjà elles est et eta étaient étais était étant été être eu eux fait faire fois font ici il ils je juste là leur leurs lui ma maintenant mais mes mine moins mon mot même ne ni nommés notre nous nouveaux par parce parole pas personnes peut peu pièce plupart que sa sans ses seulement si sien son sont sous soyez sujet sur ta tandis tels tes ton tous tout trop très tu une valeur voie voient vont votre vous vu dis dit oui non plus petit grande grand bien toute toutes rien chose choses monsieur madame aussitôt autant autrement`
    .split(/\s+/)
    .filter(Boolean)
);

function cleanWordText(raw: string) {
  let text = raw.replace(/[^\p{L}\p{N}'-]/gu, "").trim();
  // élisions : l'intérieur -> intérieur, jusqu'à -> jusqu, d'avoir -> avoir
  text = text.replace(/^(l|d|j|n|s|c|m|t|qu|jusqu)['’]/i, "");
  return text.replace(/['’]+$/, "").trim();
}

/** Formes verbales très fréquentes: mauvaises candidates à l'illustration. */
const VERB_FORMS = new Set(
  `était étaient étais Été étais avait avaient avais ayant suis sommes sont étaient sera seront serait serais avoir étant fait faisait faisaient font dit dire dirent voit voyait voyaient vint venir prit prendre mis mettre fut fut fut devait devaient devait pouvait pouvaient voulait voulaient savait savaient allait allaient fallait semblait semblaient arrivait arrivait trouvait trouvaient pensait pensaient parlait parlaient regardait regardait répondit demanda devint restait restaient devenait passait passaient montait sortait entrait commençait continuait finissait fini commencé terminé passé resté arrivé trouvé pensé parlé regardé demandé montré décidé essayé réussi oublié cherché découvert trouvé`
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase())
);

/** Fréquence des mots significatifs (pour repérer les thèmes du texte). */
function wordFrequencies(project: Project) {
  const freq = new Map<string, number>();
  for (const segment of project.transcript?.segments || []) {
    for (const word of segment.words || []) {
      const clean = cleanWordText(word.w).toLowerCase();
      if (clean.length < 4 || STOPWORDS.has(clean)) continue;
      freq.set(clean, (freq.get(clean) || 0) + 1);
    }
  }
  return freq;
}

/**
 * Mots trop abstraits pour être illustrés: ils passent souvent en tête des
 * scores "mot long" alors qu'une image ne veut rien dire pour eux.
 */
const WEAK_WORDS = new Set(
  `chose choses truc machin moment moments fois temps façon manière idée idées décision décisions problème problèmes résultat résultats niveau partie parties place monde vie gens personne personnes aujourd'hui hier demain aller faire dire voir savoir pouvoir vouloir devoir falloir prendre mettre passer rester sortir venir croire trouver donner parler penser demander tenir sembler laisser arriver sentir créer jouer aimer attendre comprendre raison sort genre type cas point points sujet matière question questions compte coup coups bout part suite début fin reste ensemble rapport exemple côté face fond aire moitié doute doutes sentiment sentiments impression impressions pensée pensées réflexion réflexions situation situations contexte moyen moyens théorie théories conclusion conclusions excitation morosité envie besoin besoins certitude certitudes habitude habitudes attention moment coup l'instant instant instants seconde secondes minute minutes heure heures semaine semaines mois année années siècle siècles recherche recherches protection protections dérouiller`
    .split(/\s+/)
    .filter(Boolean)
);

const ABSTRACTS = new Set(
  `vraiment seulement maintenant tellement probablement exactement doucement rapidement heureusement malheureusement également totalement complètement simplement évidemment finalement naturellement`
    .split(/\s+/)
    .filter(Boolean)
);

/** Noms en -ment (le reste en -ment est presque toujours un adverbe). */
const MENT_NOUNS = new Set(
  `mouvement moment moments sentiment sentiments bâtiment bâtiments vêtement vêtements monument monuments document documents instrument instruments appartement appartements jugement changement changements commencement tremblement étonnement rassemblement soulagement aboiement`
    .split(/\s+/)
    .filter(Boolean)
);

const NOUN_SUFFIX = /(tion|sion|ance|ence|ité|isme|iste|euse|esse|age|ure|ade|oir|ie|eau|elle|aille|eur|aine|ette|erie|itude|ille)$/;
const ADJ_SUFFIX = /(eux|euse|ales|ale|iques|ique|antes|ante|ant|ives|ive|if|iennes|ienne|ien|esque|âtre|ard)$/;
const VERB_SUFFIX = /(ais|ait|aient|iez|ions|erons|erez|erai|erais|èrent|ez|ons|é|ée|és|ées|er|ir|re)$/;
const ADJECTIVE_HINTS = new Set(
  `noir noire blanc blanche rouge bleu bleue vert verte jaune gris grise sombre clair doré dorée argenté vieux vieille vieil jeune grand grande petit petite beau belle joli long longue court courte chaud froid brillant étrange étranges mystérieux mystérieuse secrète secret secrète ancien ancienne nouveau nouvelle magique magiques silencieux silencieuse brumeux brumeuse profond immense minuscule bizarre magnifique terrifiant doux douce invisible lourd légère poussiéreux véritable véritables faux fausse facile difficile contournable infaisable bonne bon mauvais mauvaise premier première dernier dernière vieille seul seule`
    .split(/\s+/)
    .filter(Boolean)
);

/** Déterminants : le mot suivant est presque toujours un nom illustrable. */
const DETERMINERS = new Set(
  `le la les un une des du mon ma mes ton ta tes son sa ses notre nos votre vos leur leurs ce cet cette ces quelques plusieurs deux trois quatre cinq certains certaines chaque aucun aucune quel quelle`
    .split(/\s+/)
    .filter(Boolean)
);

/** Pronoms sujets : le mot suivant est un verbe, donc peu illustrable. */
const SUBJECT_PRONOUNS = new Set(
  `je j' tu il elle on nous vous ils elles ça cela ceci qui que je'`
    .split(/\s+/)
    .filter(Boolean)
);

type WordContext = { prev: string; next: string; isSentenceStart: boolean };

/**
 * Score d'illustrabilité d'un mot: position grammaticale (déterminant devant =
 * nom, pronom devant = verbe), suffixes, fréquence, longueur, ponctuation.
 */
function scoreWord(display: string, lower: string, freq: Map<string, number>, context: WordContext) {
  let score = 1.4;
  score += Math.min(2.0, Math.max(0, display.length - 4) * 0.3);
  score += Math.min(2.2, Math.log2(freq.get(lower) || 1) * 1.2);
  if (/^[A-ZÀ-Ý]/.test(display) && !context.isSentenceStart) score += 2.4;

  const afterDeterminer = DETERMINERS.has(context.prev) || DETERMINERS.has(context.prev.replace(/'$/, "'"));
  const afterPronoun = SUBJECT_PRONOUNS.has(context.next) ? false : SUBJECT_PRONOUNS.has(context.prev);
  const nextIsAdjective =
    ADJECTIVE_HINTS.has(context.next) || (ADJ_SUFFIX.test(context.next) && !NOUN_SUFFIX.test(context.next));

  const prevIsAdjective = ADJECTIVE_HINTS.has(context.prev) || (ADJ_SUFFIX.test(context.prev) && !NOUN_SUFFIX.test(context.prev));
  if (afterDeterminer) score += 2.6; // "le cahier", "une forêt"
  if (nextIsAdjective && !afterPronoun) score += 0.9; // "cahier noir"
  if (prevIsAdjective) score += 1.8; // "un vieux grimoire" -> grimoire
  if (afterPronoun) score -= 2.6; // "je décidai"

  if (MENT_NOUNS.has(lower)) score += 1.8;
  else if (NOUN_SUFFIX.test(lower)) score += 1.6;
  if (ADJECTIVE_HINTS.has(lower) || (ADJ_SUFFIX.test(lower) && !NOUN_SUFFIX.test(lower))) score -= 2.0;
  if (ABSTRACTS.has(lower)) score -= 3.6;
  else if (/ment$/.test(lower) && !MENT_NOUNS.has(lower)) score -= 2.0;
  if (WEAK_WORDS.has(lower)) score -= 2.8;
  if (VERB_FORMS.has(lower)) score -= 3.2;
  if (VERB_SUFFIX.test(lower) && !NOUN_SUFFIX.test(lower) && !ADJECTIVE_HINTS.has(lower)) score -= 1.4;
  // infinitifs : « vouloir », « déverrouiller »… peu illustrables
  if (!NOUN_SUFFIX.test(lower) && /(er|ir)$/.test(lower) && lower.length >= 5) score -= 1.6;
  else if (!NOUN_SUFFIX.test(lower) && /re$/.test(lower) && lower.length >= 6) score -= 0.8;
  if (lower.length < 5) score -= 0.7;
  if (lower.includes("-")) score -= 0.8; // « Serions-nous », mots composés
  return score;
}

/** Score minimal pour qu'un mot soit jugé "illustrable". */
const KEYWORD_MIN_SCORE = 3.5;

type AutoSlot = { start: number; end: number; keywords: string[]; scores: number[]; top: string };

/**
 * Découpe la narration en créneaux et repère les mots illustrables de chacun:
 * noms concrets, mots propres, thèmes récurrents, et paires nom + adjectif.
 */
function buildAutoSlots(project: Project, minDuration: number): AutoSlot[] {
  const transcript = project.transcript;
  if (!transcript) return [];
  const freq = wordFrequencies(project);
  const slots: AutoSlot[] = [];
  let bucket:
    | { start: number; end: number; candidates: Map<string, { display: string; score: number }>; words: { display: string; lower: string; score: number }[] }
    | null = null;

  const flush = () => {
    if (!bucket) return;
    const words = bucket.words;
    // bigrammes nom + adjectif: « cahier noir », « forêt brumeuse »
    for (let i = 0; i < words.length - 1; i++) {
      const a = words[i];
      const b = words[i + 1];
      const aNoun = NOUN_SUFFIX.test(a.lower) && !WEAK_WORDS.has(a.lower) && !VERB_FORMS.has(a.lower);
      const bAdj =
        (ADJECTIVE_HINTS.has(b.lower) || ADJ_SUFFIX.test(b.lower)) &&
        !NOUN_SUFFIX.test(b.lower) &&
        !WEAK_WORDS.has(b.lower) &&
        !VERB_FORMS.has(b.lower) &&
        !ABSTRACTS.has(b.lower);
      if (aNoun && bAdj && a.score > KEYWORD_MIN_SCORE && b.score > 2.6) {
        const pair = `${a.display} ${b.display}`;
        const key = pair.toLowerCase();
        bucket.candidates.set(key, { display: pair, score: a.score + b.score * 0.55 + 1.4 });
      }
    }
    const ranked = [...bucket.candidates.values()]
      .filter((candidate) => candidate.score >= KEYWORD_MIN_SCORE)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    if (ranked.length) {
      slots.push({
        start: bucket.start,
        end: bucket.end,
        keywords: ranked.map((r) => r.display),
        scores: ranked.map((r) => Math.round(r.score * 10) / 10),
        top: ranked[0].display,
      });
    }
    bucket = null;
  };

  for (const segment of transcript.segments) {
    const words = (segment.words || []).filter((w) => /[\p{L}\p{N}]/u.test(w.w || ""));
    words.forEach((word, index) => {
      const display = cleanWordText(word.w);
      const lower = display.toLowerCase();
      if (!display || lower.length < 4 || STOPWORDS.has(lower)) return;
      if (!bucket) bucket = { start: word.s, end: word.e, candidates: new Map(), words: [] };
      bucket.end = Math.max(bucket.end, word.e);
      const prevRaw = index > 0 ? cleanWordText(words[index - 1].w).toLowerCase() : "";
      const nextRaw = index < words.length - 1 ? cleanWordText(words[index + 1].w).toLowerCase() : "";
      const score = scoreWord(display, lower, freq, {
        prev: prevRaw,
        next: nextRaw,
        isSentenceStart: index === 0,
      });
      const existing = bucket.candidates.get(lower);
      if (!existing || existing.score < score) bucket.candidates.set(lower, { display, score });
      bucket.words.push({ display, lower, score });
    });
    if (bucket && bucket.end - bucket.start >= minDuration) flush();
    else if (bucket) flush();
  }
  flush();
  return slots;
}

/** Empêche de répéter la même illustration deux fois de suite. */
function pickKeyword(slot: AutoSlot, used: Set<string>) {
  for (const keyword of slot.keywords) {
    const head = keyword.toLowerCase().split(" ")[0];
    if (!used.has(keyword.toLowerCase()) && !used.has(head)) return keyword;
  }
  return slot.keywords[0] || "";
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleApi(req: Request, parts: string[], url: URL): Promise<Response> {
  const method = req.method.toUpperCase();
  const [root, a, b, c, d] = parts;

  if (root !== "api") return new Response("Not found", { status: 404 });

  // --- jobs ---------------------------------------------------------------
  if (a === "jobs") {
    if (!b) return json({ jobs: listJobs() });
    if (b && c === "events") return jobEventStream(b);
    const job = getJob(b);
    return job ? json(job) : badRequest("Tâche inconnue", 404);
  }

  // --- polices Google ---
  if (a === "fonts") {
    if (method === "GET") return json({ fonts: await listFonts() });
    if (method === "POST") {
      const body = await readBody<{ id?: string; all?: boolean }>(req);
      const job = createJob("fonts", "Téléchargement des polices");
      (async () => {
        if (body.all) {
          await installRecommendedFonts((p, message) => updateJob(job.id, { progress: p, message: message || "Polices…" }));
        } else {
          await installFont(body.id || "Outfit", (p, message) =>
            updateJob(job.id, { progress: p, message: message || "Téléchargement…" })
          );
        }
        finishJob(job.id, { fonts: await listFonts() }, "Polices installées");
      })().catch((e) => failJob(job.id, e instanceof Error ? e.message : String(e)));
      return json({ job: job.id });
    }
  }

  if (a === "imgproxy") {
    const target = url.searchParams.get("url");
    if (!target) return badRequest("url manquante");
    try {
      return await proxyImage(target, url.searchParams.get("referer") || undefined);
    } catch (e) {
      return badRequest(e instanceof Error ? e.message : String(e), 502);
    }
  }

  // --- setup --------------------------------------------------------------
  if (a === "setup") {
    if (b === "status" && method === "GET") {
      const whisper = await whisperStatus();
      return json({ ffmpeg: ffmpegAvailable(), whisper });
    }
    if (b === "whisper" && method === "POST") {
      const body = await readBody<{ model?: string }>(req);
      const job = createJob("whisper-install", "Installation de Whisper");
      installWhisper(body.model || "ggml-small.bin", (p, msg) =>
        updateJob(job.id, { progress: p, message: msg || "Installation…" })
      )
        .then(() => finishJob(job.id, { ok: true }, "Whisper installé"))
        .catch((e) => failJob(job.id, e instanceof Error ? e.message : String(e)));
      return json({ job: job.id });
    }
    if (b === "rnnoise" && method === "POST") {
      const job = createJob("rnnoise-install", "Installation du modèle RNNoise");
      installRnnoise((p, msg) => updateJob(job.id, { progress: p, message: msg || "Téléchargement…" }))
        .then(() => finishJob(job.id, { ok: true }, "RNNoise installé"))
        .catch((e) => failJob(job.id, e instanceof Error ? e.message : String(e)));
      return json({ job: job.id });
    }
    return badRequest("Route setup inconnue", 404);
  }

  // --- projects -----------------------------------------------------------
  if (a !== "projects") return badRequest("Route API inconnue", 404);

  if (!b && method === "GET") {
    const projects = await listProjects();
    return json({ projects: projects.map((p) => ({ id: p.id, name: p.name, updatedAt: p.updatedAt, duration: montageDuration(p), sources: p.sources.length, clips: p.videoTrack.length })) });
  }

  if (!b && method === "POST") {
    const body = await readBody<{ name?: string }>(req);
    const project = await createProject(body.name || "Nouveau montage");
    return json({ project: serialize(project) });
  }

  if (!b) return badRequest("Projet manquant");

  const project = await getProject(b);
  if (!project) return badRequest("Projet introuvable", 404);
  const pid = project.id;

  // /api/projects/:id
  if (!c && method === "GET") return json({ project: serialize(project) });
  if (!c && method === "DELETE") {
    await fs.rm(projectDir(pid), { recursive: true, force: true });
    return json({ ok: true });
  }

  // /api/projects/:id/update  (état générique: nom, sorties, clips, pistes)
  if (c === "update" && method === "POST") {
    const body = await readBody<Partial<Project>>(req);
    if (body.name) project.name = String(body.name).slice(0, 120);
    if (body.output) project.output = { ...project.output, ...body.output };
    if (Array.isArray(body.videoTrack)) {
      const transitions = ["cut", "fade-black", "dissolve", "slide-left", "slide-right", "slide-up", "slide-down", "zoom-in"];
      project.videoTrack = body.videoTrack
        .map((clip) => ({
          ...clip,
          start: clamp(Number(clip.start) || 0, 0, 1e6),
          duration: Math.max(0.05, Number(clip.duration) || 1),
          offset: Math.max(0, Number(clip.offset) || 0),
          effect: {
            fadeIn: clamp(Number(clip.effect?.fadeIn) || 0, 0, 10),
            fadeOut: clamp(Number(clip.effect?.fadeOut) || 0, 0, 10),
            kenBurns: !!clip.effect?.kenBurns,
            zoomFrom: Number(clip.effect?.zoomFrom) || 1,
            zoomTo: Number(clip.effect?.zoomTo) || 1.1,
            transition: {
              type: transitions.includes(String(clip.effect?.transition?.type))
                ? (clip.effect?.transition?.type as any)
                : "fade-black",
              duration: clamp(Number(clip.effect?.transition?.duration) || 0, 0, 4),
            },
          },
        }))
        .filter((clip) => project.sources.some((s) => s.id === clip.sourceId));
    }
    if (body.subtitles) {
      const incoming = body.subtitles as any;
      const current = { ...defaultSubtitles(), ...(project.subtitles || {}) };
      project.subtitles = {
        ...current,
        ...incoming,
        enabled: !!incoming.enabled,
        fontSize: clamp(Number(incoming.fontSize ?? current.fontSize), 16, 160),
        outlineWidth: clamp(Number(incoming.outlineWidth ?? current.outlineWidth), 0, 12),
        maxWordsPerLine: clamp(Number(incoming.maxWordsPerLine ?? current.maxWordsPerLine), 1, 12),
        marginBottom: clamp(Number(incoming.marginBottom ?? current.marginBottom), 0, 400),
        position: ["bottom", "middle", "top"].includes(incoming.position) ? incoming.position : current.position,
        animation: ["none", "fade", "pop", "slide"].includes(incoming.animation) ? incoming.animation : current.animation,
      };
    }
    if (Array.isArray(body.audioTracks)) {
      project.audioTracks = body.audioTracks.map((track) => ({
        ...track,
        clips: (track.clips || [])
          .filter((clip) => project.sources.some((s) => s.id === clip.sourceId))
          .map((clip) => ({
            ...clip,
            start: clamp(Number(clip.start) || 0, 0, 1e6),
            duration: Math.max(0.05, Number(clip.duration) || 1),
            offset: Math.max(0, Number(clip.offset) || 0),
            gain: clamp(Number(clip.gain ?? 1), 0, 4),
            fadeIn: clamp(Number(clip.fadeIn) || 0, 0, 30),
            fadeOut: clamp(Number(clip.fadeOut) || 0, 0, 30),
          })),
      }));
    }
    await saveProject(project);
    return json({ project: serialize(project) });
  }

  // /api/projects/:id/upload  (multipart)
  if (c === "upload" && method === "POST") {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return badRequest("Fichier manquant");
    const role = String(form.get("role") || ""); // voice | clip | music
    const name = sanitizeText(String(form.get("name") || file.name || "media"), "média");
    await ensureProjectDirs(pid);
    await ensureDir(mediaDir(pid));
    const ext = (name.match(/\.[a-z0-9]+$/i)?.[0] || ".bin").toLowerCase();
    const fileName = `${newId("src")}-${slug(name.replace(/\.[a-z0-9]+$/i, ""))}${ext}`;
    const fullPath = `${mediaDir(pid)}/${fileName}`;
    await Bun.write(fullPath, file);

    let info;
    try {
      info = await probe(fullPath);
    } catch (e) {
      await fs.rm(fullPath, { force: true });
      return badRequest(`Fichier illisible : ${e instanceof Error ? e.message : String(e)}`);
    }
    const mime = (file.type || "").toLowerCase();
    const imageExt = /\.(jpe?g|png|webp|gif|bmp|avif|tiff?)$/i.test(name);
    const kind: Source["kind"] = mime.startsWith("image/") || imageExt ? "image" : info.hasVideo ? "video" : "audio";

    const source: Source = {
      id: newId("src"),
      kind,
      name,
      file: fileName,
      duration: info.duration,
      sampleRate: info.sampleRate,
      channels: info.channels,
      width: info.width,
      height: info.height,
      fps: info.fps,
      origin: role === "voice" ? "record" : "upload",
      createdAt: Date.now(),
    };
    project.sources.push(source);
    const warnings: string[] = [];
    if (role === "voice") {
      project.voice.sourceId = source.id;
      project.voice.edits = defaultEdits();
    }
    if (role === "music" || role === "clip") {
      // rien de spécial: la source est prête à être posée sur une piste
    }
    await saveProject(project);
    if (role === "voice") await recompile(project, warnings);
    return json({ project: serialize(project), source, warnings });
  }

  // --- voix ---------------------------------------------------------------
  if (c === "voice") {
    if (d === "source" && method === "POST") {
      const body = await readBody<{ sourceId?: string }>(req);
      const source = project.sources.find((s) => s.id === body.sourceId);
      if (!source) return badRequest("Source introuvable");
      if (source.kind === "image") return badRequest("Une image ne peut pas être une piste voix");
      const existing = project.sources.find((s) => s.id === project.voice.sourceId);
      if (existing && existing.id !== source.id) {
        // on garde la source, mais on réinitialise le montage précédent
        project.voice.edits = defaultEdits();
      } else if (!project.voice.edits) {
        project.voice.edits = defaultEdits();
      }
      project.voice.sourceId = source.id;
      project.transcript = undefined;
      await saveProject(project);
      const warnings: string[] = [];
      await recompile(project, warnings);
      return json({ project: serialize(project), warnings });
    }

    if (d === "compile" && method === "POST") {
      const warnings: string[] = [];
      await recompile(project, warnings);
      await saveProject(project);
      return json({ project: serialize(project), warnings });
    }

    if (d === "detect" && method === "POST") {
      const body = await readBody<{ thresholdDb?: number; minDuration?: number }>(req);
      const source = project.sources.find((s) => s.id === project.voice.sourceId);
      if (!source) return badRequest("Aucune piste voix");
      const thresholdDb = clamp(Number(body.thresholdDb ?? -35), -80, -10);
      const minDuration = clamp(Number(body.minDuration ?? 0.35), 0.1, 5);
      const silences = source.duration
        ? await detectSilences(sourcePath(pid, source), thresholdDb, minDuration)
        : [];
      const segments = project.voice.build?.segments ?? buildSegments(project.voice.edits, source.duration);
      const inOut = silences
        .map((s) => ({
          start: segments.find((seg) => s.start >= seg.srcStart && s.start <= seg.srcEnd)
            ? (() => {
                const seg = segments.find((g) => s.start >= g.srcStart && s.start <= g.srcEnd)!;
                return seg.outStart + (s.start - seg.srcStart) / seg.tempo;
              })()
            : null,
          end: (() => {
            const seg = segments.find((g) => s.end >= g.srcStart && s.end <= g.srcEnd);
            return seg ? seg.outStart + (s.end - seg.srcStart) / seg.tempo : null;
          })(),
        }))
        .filter((r) => r.start !== null && r.end !== null) as { start: number; end: number }[];
      return json({
        silences,
        inOut,
        total: silences.reduce((acc, s) => acc + (s.end - s.start), 0),
        savedAtX100: silences.reduce((acc, s) => acc + (s.end - s.start) * (1 - 1 / project.voice.edits.ffwdFactor), 0),
      });
    }

    if (d === "ffwd" && method === "POST") {
      const body = await readBody<{ enabled?: boolean; thresholdDb?: number; minDuration?: number; factor?: number }>(
        req
      );
      const source = project.sources.find((s) => s.id === project.voice.sourceId);
      if (!source) return badRequest("Aucune piste voix");
      const factor = clamp(Number(body.factor ?? project.voice.edits.ffwdFactor ?? 100), 2, 100);
      project.voice.edits.ffwdFactor = factor;
      if (body.enabled === false) {
        project.voice.edits.ffwd = [];
      } else {
        const thresholdDb = clamp(Number(body.thresholdDb ?? -35), -80, -10);
        const minDuration = clamp(Number(body.minDuration ?? 0.35), 0.1, 5);
        const silences = await detectSilences(sourcePath(pid, source), thresholdDb, minDuration);
        project.voice.edits.ffwd = mergeRanges(silences);
      }
      await saveProject(project);
      const warnings: string[] = [];
      await recompile(project, warnings);
      return json({ project: serialize(project), warnings });
    }

    if (d === "cut" && method === "POST") {
      const body = await readBody<{ start?: number; end?: number }>(req);
      const source = project.sources.find((s) => s.id === project.voice.sourceId);
      if (!source) return badRequest("Aucune piste voix");
      const segments = project.voice.build?.segments ?? buildSegments(project.voice.edits, source.duration);
      const start = clamp(Number(body.start ?? 0), 0, 1e9);
      const end = clamp(Number(body.end ?? 0), 0, 1e9);
      if (end - start < 0.01) return badRequest("Sélection trop courte");
      const sourceRanges = mapOutToSource(segments, start, end);
      project.voice.edits.cuts = mergeRanges([...project.voice.edits.cuts, ...sourceRanges]);
      await saveProject(project);
      const warnings: string[] = [];
      await recompile(project, warnings);
      return json({ project: serialize(project), warnings });
    }

    if (d === "denoise" && method === "POST") {
      const body = await readBody<{
        mode?: "none" | "auto" | "profile" | "rnnoise";
        reduction?: number;
        sample?: { start: number; end: number } | null;
      }>(req);
      const mode = body.mode || "none";
      project.voice.edits.denoise = {
        ...project.voice.edits.denoise,
        mode,
        reduction: clamp(Number(body.reduction ?? project.voice.edits.denoise.reduction ?? 12), 0.1, 97),
      };
      let measured: { rmsDb: number; peakDb: number } | null = null;
      if (mode === "profile") {
        const source = project.sources.find((s) => s.id === project.voice.sourceId);
        if (!source) return badRequest("Aucune piste voix");
        const segments = project.voice.build?.segments ?? buildSegments(project.voice.edits, source.duration);
        let range = body.sample || project.voice.edits.denoise.sample || null;
        if (range) {
          const srcRanges = mapOutToSource(segments, range.start, range.end);
          if (srcRanges.length) {
            const first = srcRanges[0];
            const last = srcRanges[srcRanges.length - 1];
            range = { start: first.start, end: last.end };
          }
        }
        if (!range) return badRequest("Sélectionne d'abord une zone de silence (blanc) dans la forme d'onde");
        measured = await measureRegion(sourcePath(pid, source), range);
        project.voice.edits.denoise.sample = range;
        project.voice.edits.denoise.floorDb = Math.round((measured.rmsDb - 2) * 10) / 10;
      }
      await saveProject(project);
      const warnings: string[] = [];
      await recompile(project, warnings);
      return json({ project: serialize(project), measured, warnings });
    }

    if (d === "normalize" && method === "POST") {
      const body = await readBody<{ enabled?: boolean }>(req);
      project.voice.edits.normalize = !!body.enabled;
      await saveProject(project);
      const warnings: string[] = [];
      await recompile(project, warnings);
      return json({ project: serialize(project), warnings });
    }

    if (d === "reset" && method === "POST") {
      // on garde la transcription (elle sera marquée comme obsolète par le hash du montage)
      project.voice.edits = defaultEdits();
      await saveProject(project);
      const warnings: string[] = [];
      await recompile(project, warnings);
      return json({ project: serialize(project), warnings });
    }

    if (d === "level" && method === "GET") {
      const source = project.sources.find((s) => s.id === project.voice.sourceId);
      if (!source) return badRequest("Aucune piste voix");
      const info = await measureRegion(sourcePath(pid, source), { start: 0, end: source.duration });
      return json({ level: info, build: project.voice.build?.stats });
    }
    return badRequest("Route voix inconnue", 404);
  }

  // --- retouche d'image --------------------------------------------------
  if (c === "edit-image" && method === "POST") {
    const body = await readBody<{ sourceId?: string; keyword?: string; ops?: Record<string, any> }>(req);
    const source = project.sources.find((s) => s.id === body.sourceId);
    if (!source || source.kind !== "image") return badRequest("Image introuvable");
    try {
      const edited = await editImage(project, source, body.ops || {}, sanitizeText(String(body.keyword || source.meta?.keyword || "")));
      project.sources.push(edited);
      await saveProject(project);
      return json({ project: serialize(project), source: edited });
    } catch (e) {
      return badRequest(e instanceof Error ? e.message : String(e));
    }
  }

  // --- édition de la transcription ---------------------------------------
  if (c === "transcript" && d === "edit" && method === "POST") {
    const body = await readBody<{ action?: string; segmentId?: string; index?: number; text?: string }>(req);
    if (!project.transcript) return badRequest("Pas de transcription");
    const segments = project.transcript.segments;
    const segment = segments.find((s) => s.id === body.segmentId);
    if (!segment) return badRequest("Segment introuvable");
    const action = body.action || "update-word";
    if (action === "delete-segment") {
      project.transcript.segments = segments.filter((s) => s.id !== segment.id);
    } else if (action === "delete-word") {
      segment.words.splice(Number(body.index) || 0, 1);
      segment.text = segment.words.map((w) => w.w).join(" ");
      if (!segment.words.length) project.transcript.segments = segments.filter((s) => s.id !== segment.id);
    } else {
      const index = Number(body.index);
      const word = segment.words[index];
      if (!word) return badRequest("Mot introuvable");
      const text = sanitizeText(String(body.text ?? word.w));
      if (!text) return badRequest("Texte vide");
      if (text !== word.w) word.edited = true;
      word.w = text;
      segment.text = segment.words.map((w) => w.w).join(" ");
    }
    await saveProject(project);
    return json({ project: serialize(project) });
  }

  // --- mot-clé d'un clip (pour proposer d'autres illustrations) ----------
  if (c === "clips" && d === "keyword" && method === "GET") {
    const clipId = url.searchParams.get("clipId") || "";
    const clip = project.videoTrack.find((x) => x.id === clipId);
    if (!clip) return badRequest("Clip introuvable", 404);
    let keyword = clip.keyword || "";
    if (!keyword) {
      const words = (project.transcript?.segments || [])
        .flatMap((s) => s.words.map((w) => ({ ...w, segId: s.id })))
        .filter((w) => w.s >= clip.start - 1.5 && w.s <= clip.start + clip.duration)
        .map((w) => cleanWordText(w.w))
        .filter((w) => w && !STOPWORDS.has(w.toLowerCase()));
      keyword = words.sort((a, b) => b.length - a.length)[0] || "";
    }
    return json({ keyword });
  }

  // --- transcription ------------------------------------------------------
  if (c === "transcribe" && method === "POST") {
    const body = await readBody<{ model?: string; language?: string }>(req);
    const job = createJob("transcribe", "Transcription Whisper");
    transcribe(project, { model: body.model, language: body.language }, (p, msg) =>
      updateJob(job.id, { progress: p, message: msg || "Transcription…" })
    )
      .then(async (transcript) => {
        const fresh = await getProject(pid);
        if (fresh) {
          fresh.transcript = transcript;
          await saveProject(fresh);
        }
        finishJob(job.id, { segments: transcript.segments.length, language: transcript.language }, "Transcription terminée");
      })
      .catch((e) => failJob(job.id, e instanceof Error ? e.message : String(e)));
    return json({ job: job.id });
  }

  if (c === "transcript" && method === "GET") {
    return json({ transcript: project.transcript ?? null });
  }

  // --- recherche d'illustrations ------------------------------------------
  if (c === "search" && method === "POST") {
    const body = await readBody<{ query?: string; provider?: string; count?: number }>(req);
    const query = (body.query || "").trim();
    if (!query) return badRequest("Requête vide");
    const { results, errors } = await searchImages(query, { provider: body.provider, count: body.count });
    return json({ query, results, errors });
  }

  if (c === "add-image" && method === "POST") {
    const body = await readBody<{
      url?: string;
      fallbackUrl?: string;
      referer?: string;
      keyword?: string;
      provider?: string;
      start?: number;
      duration?: number;
    }>(req);
    if (!body.url) return badRequest("URL manquante");
    const keyword = sanitizeText(String(body.keyword || ""));
    const source = await downloadImage(project, {
      url: body.url,
      fallbackUrl: body.fallbackUrl,
      referer: body.referer,
      keyword,
      provider: body.provider,
    });
    project.sources.push(source);
    const clip: VideoClip = {
      id: newId("clip"),
      sourceId: source.id,
      keyword,
      start: Math.max(0, Number(body.start) || 0),
      duration: clamp(Number(body.duration) || 3, 0.2, 600),
      offset: 0,
      effect: defaultEffect(),
      createdAt: Date.now(),
    };
    project.videoTrack.push(clip);
    project.videoTrack.sort((x, y) => x.start - y.start);
    await saveProject(project);
    return json({ project: serialize(project), source, clip });
  }

  if (c === "keywords" && method === "GET") {
    const minDuration = clamp(Number(url.searchParams.get("minDuration") || 3.2), 1.5, 20);
    const slots = buildAutoSlots(project, minDuration).map((slot, index) => ({
      index,
      start: Number(slot.start.toFixed(2)),
      end: Number(slot.end.toFixed(2)),
      keyword: slot.top,
      alternatives: slot.keywords,
      scores: slot.scores,
    }));
    return json({ slots, hasTranscript: !!project.transcript });
  }

  if (c === "auto" && method === "POST") {
    const body = await readBody<{
      maxClips?: number;
      minDuration?: number;
      provider?: string;
      transitions?: boolean;
      kenBurns?: boolean;
      subtitles?: boolean;
      replace?: boolean;
      variants?: number;
      slots?: { start?: number; end?: number; keyword?: string }[];
    }>(req);
    const job = createJob("auto-montage", "Montage automatique");
    (async () => {
      if (!project.transcript) throw new Error("Lance d'abord la transcription Whisper");
      if (!project.voice.build) throw new Error("Compile d'abord la piste voix");
      const maxClips = clamp(Number(body.maxClips ?? 30), 1, 120);
      const minDuration = clamp(Number(body.minDuration ?? 2.6), 1, 20);
      const provider = body.provider || "web";
      const withTransitions = body.transitions !== false;
      const withKenBurns = body.kenBurns !== false;
      const variants = clamp(Number(body.variants ?? 1), 1, 3);
      const total = project.voice.build.duration;

      let slots: AutoSlot[] = [];
      if (Array.isArray(body.slots) && body.slots.length) {
        // liste de mots-clés validée/éditée par l'utilisateur
        slots = body.slots
          .map((slot) => ({
            start: Math.max(0, Number(slot.start) || 0),
            end: Math.max(0, Number(slot.end) || 0),
            keywords: [String(slot.keyword || "").trim()],
            scores: [1],
            top: String(slot.keyword || "").trim(),
          }))
          .filter((slot) => slot.keywords[0])
          .sort((a, b) => a.start - b.start);
      } else {
        slots = buildAutoSlots(project, minDuration);
      }
      if (!slots.length) throw new Error("Aucun mot-clé exploitable dans la transcription");
      // garder les créneaux les mieux notés, répartis sur toute la narration
      if (slots.length > maxClips) {
        const keep = new Set<number>();
        const step = slots.length / maxClips;
        for (let i = 0; i < maxClips; i++) keep.add(Math.round(i * step));
        slots = slots.filter((_, i) => keep.has(i));
      }

      const fresh = await getProject(pid);
      if (!fresh) throw new Error("Projet perdu");
      const newSources: Source[] = [];
      const clips: VideoClip[] = [];
      const used = new Set<string>();
      const cache = new Map<string, { url: string; referer?: string; provider: string }>();
      const resultCache = new Map<string, { url: string; thumb?: string; pageUrl?: string; provider: string }[]>();
      const reusable = new Map<string, Source>();
      for (const source of fresh.sources) {
        const keyword = String(source.meta?.keyword || "").toLowerCase();
        if (source.kind === "image" && keyword && !reusable.has(keyword)) reusable.set(keyword, source);
      }

      const transitionDuration = withTransitions ? 0.7 : 0;
      let index = 0;
      for (let i = 0; i < slots.length; i++) {
        const slot = slots[i];
        index++;
        const start = Math.max(0, Math.min(i === 0 ? Math.max(0, slot.start - 0.4) : slot.start, total));
        const nextStart = i + 1 < slots.length ? Math.max(slots[i + 1].start, start + 1) : total;
        const end = Math.min(total, Math.max(nextStart, slot.end + 0.4));
        const duration = Math.max(1, end - start);
        updateJob(job.id, {
          progress: (index / slots.length) * 0.95,
          message: `Illustration ${index}/${slots.length} — ${Math.round(start)}s → ${Math.round(end)}s`,
        });

        let placed = false;
        for (let attempt = 0; attempt < slot.keywords.length && !placed; attempt++) {
          const keyword = attempt === 0 ? pickKeyword(slot, used) : slot.keywords[attempt];
          if (!keyword) continue;
          const key = keyword.toLowerCase();
          try {
            updateJob(job.id, { message: `Recherche « ${keyword} »…` });
            let results = resultCache.get(key);
            if (!results) {
              const search = await searchImages(keyword, { provider, count: 10 });
              results = search.results.slice(0, Math.max(4, variants)).map((r) => ({
                url: r.url,
                thumb: r.thumb,
                pageUrl: r.pageUrl,
                provider: r.provider,
              }));
              if (results.length) resultCache.set(key, results);
            }
            if (!results?.length) continue;

            // une ou plusieurs illustrations pour ce mot-clé
            const wanted = Math.min(variants, results.length);
            const pieces: { source: Source }[] = [];
            for (let v = 0; v < wanted; v++) {
              const candidate = results[v];
              try {
                const source = await downloadImage(fresh, {
                  url: candidate.url,
                  fallbackUrl: candidate.thumb,
                  referer: candidate.pageUrl,
                  keyword,
                  provider: candidate.provider,
                });
                newSources.push(source);
                reusable.set(key + (v || ""), source);
                pieces.push({ source });
              } catch (e) {
                updateJob(job.id, { log: `« ${keyword} » (${v + 1}) indisponible : ${e instanceof Error ? e.message : e}` });
              }
            }
            if (!pieces.length) continue;
            used.add(key);
            used.add(key.split(" ")[0]);
            const slice = duration / pieces.length;
            pieces.forEach((piece, v) => {
              const pieceStart = start + v * slice;
              const isLastPiece = i + 1 >= slots.length && v === pieces.length - 1;
              clips.push({
                id: newId("clip"),
                sourceId: piece.source.id,
                keyword,
                start: pieceStart,
                duration: isLastPiece ? slice : slice + transitionDuration,
                offset: 0,
                effect: {
                  fadeIn: 0.4,
                  fadeOut: isLastPiece ? 0.8 : 0,
                  kenBurns: withKenBurns,
                  zoomFrom: 1,
                  zoomTo: 1.12,
                  transition: { type: withTransitions ? "dissolve" : "fade-black", duration: transitionDuration },
                },
                createdAt: Date.now(),
              });
            });
            placed = true;
          } catch (e) {
            updateJob(job.id, { log: `« ${keyword} » indisponible : ${e instanceof Error ? e.message : e}` });
          }
        }
        if (!placed) updateJob(job.id, { log: `Créneau ${Math.round(start)}s : aucune image trouvée` });
      }

      const latest = await getProject(pid);
      if (!latest) throw new Error("Projet perdu");
      latest.sources.push(...newSources);
      latest.videoTrack = body.replace === false ? [...latest.videoTrack, ...clips].sort((x, y) => x.start - y.start) : clips.sort((x, y) => x.start - y.start);
      if (body.subtitles && latest.transcript) {
        latest.subtitles = { ...(latest.subtitles || defaultSubtitles()), enabled: true };
      }
      await saveProject(latest);
      finishJob(job.id, { project: serialize(latest), clips: clips.length }, `${clips.length} illustrations placées`);
    })().catch((e) => failJob(job.id, e instanceof Error ? e.message : String(e)));
    return json({ job: job.id });
  }

  // --- sous-titres --------------------------------------------------------
  if (c === "subtitles" && method === "GET") {
    const style = { ...defaultSubtitles(), ...(project.subtitles || {}) };
    const lines = project.transcript ? subtitleLines(project, style.maxWordsPerLine) : [];
    return json({ subtitles: style, lines, presets: SUBTITLE_PRESETS });
  }

  // --- export -------------------------------------------------------------
  if (c === "export" && method === "POST") {
    const body = await readBody<{
      fileName?: string;
      width?: number;
      height?: number;
      fps?: number;
      crf?: number;
      normalize?: boolean;
    }>(req);
    if (!project.voice.build) return badRequest("Compile d'abord la piste voix");
    const job = createJob("export", "Rendu du montage");
    const opts = {
      fileName: body.fileName || `${slug(project.name)}.mp4`,
      width: clamp(Number(body.width) || project.output.width, 240, 3840),
      height: clamp(Number(body.height) || project.output.height, 240, 2160),
      fps: clamp(Number(body.fps) || project.output.fps, 12, 60),
      crf: clamp(Number(body.crf ?? project.output.crf), 12, 32),
      normalize: body.normalize ?? project.output.normalize,
    };
    project.output = { ...project.output, width: opts.width, height: opts.height, fps: opts.fps, crf: opts.crf, normalize: !!opts.normalize };
    await saveProject(project);
    renderMontage(project, opts, (p, msg) => updateJob(job.id, { progress: p, message: msg || "Rendu…" }))
      .then((result) => finishJob(job.id, result, "Rendu terminé"))
      .catch((e) => failJob(job.id, e instanceof Error ? e.message : String(e)));
    return json({ job: job.id });
  }

  // --- sources ------------------------------------------------------------
  if (c === "sources" && d && method === "DELETE") {
    const source = project.sources.find((s) => s.id === d);
    if (!source) return badRequest("Source introuvable");
    project.sources = project.sources.filter((s) => s.id !== d);
    project.videoTrack = project.videoTrack.filter((clip) => clip.sourceId !== d);
    project.audioTracks = project.audioTracks
      .map((track) => ({ ...track, clips: track.clips.filter((clip) => clip.sourceId !== d) }))
      .filter(Boolean) as AudioTrack[];
    if (project.voice.sourceId === d) {
      project.voice.sourceId = undefined;
      project.voice.build = undefined;
      project.transcript = undefined;
    }
    await saveProject(project);
    await deleteSourceFile(pid, source);
    return json({ project: serialize(project) });
  }

  return badRequest("Route projet inconnue", 404);
}

// ---------------------------------------------------------------------------
// Routeur
// ---------------------------------------------------------------------------

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const parts = url.pathname
    .split("/")
    .filter(Boolean)
    .map((p) => {
      try {
        return decodeURIComponent(p);
      } catch {
        return p;
      }
    });

  try {
    if (parts[0] === "api") return await handleApi(req, parts, url);
    if (parts[0] === "fonts" && parts[1]) {
      const file = Bun.file(`${FONT_TTF_DIR}/${path.basename(parts[1])}`);
      if (!(await file.exists())) return new Response("Police introuvable", { status: 404 });
      return new Response(file, { headers: { "cache-control": "public, max-age=86400" } });
    }
    if (parts[0] === "media" && parts.length >= 3) {
      return await serveProjectFile(parts[1], parts.slice(2).join("/"));
    }
    if (parts.length === 0) return serveStatic("index.html");
    return serveStatic(parts.join("/"));
  } catch (e) {
    console.error("Erreur serveur", e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
}

function findAvailablePort(start: number, end: number) {
  for (let port = start; port <= end; port++) {
    try {
      return Bun.serve({ port, fetch: handler, maxRequestBodySize: 1024 * 1024 * 1024, idleTimeout: 255 });
    } catch {
      console.log(`  port ${port} occupé — essai ${port + 1}…`);
    }
  }
  return null;
}

const server = findAvailablePort(MIN_PORT, MAX_PORT);
if (!server) {
  console.error(`Aucun port libre entre ${MIN_PORT} et ${MAX_PORT} — abandon.`);
  process.exit(1);
}
await ensureDir(DATA_DIR, `${DATA_DIR}/cache`, FONTS_DIR, FONT_TTF_DIR);
console.log(`🟤 ${NAME} prêt → http://localhost:${server.port}`);

// polices recommandées en tâche de fond (silencieux, non bloquant)
installRecommendedFonts().catch(() => {});
