import type { Project } from "./store";

/**
 * Moteur de mots-clés : repère dans la transcription les mots illustrables
 * (noms concrets, mots propres, thèmes récurrents, paires nom + adjectif) puis
 * découpe la narration en créneaux. Extrait de l'index pour être testable seul.
 */

const STOPWORDS = new Set(
  `néanmoins effectivement également ensuite enfin puis bref voici voilà lorsque lorsqu jusqu jusque malgré selon hélas auprès environ presque toujours jamais souvent parfois plutôt vraiment seulement encore aussi autant tant tellement trop peu beaucoup moins davantage ainsi alors donc car or ni mais ou et quand comment pourquoi combien quel quelle quels quelles lequel laquelle lesquels lesquelles celui celle ceux celles ceci cela ça ce cet cette ces mon ma mes ton ta tes son sa ses notre nos votre vos leur leurs moi toi lui elle nous vous eux elles qui que quoi dont où y en le la les un une des du de à au aux par pour sans sous sur dans avec chez vers entre depuis pendant après avant contre hors suivant hormis alors au aucun aussi autre aux avais avait avant avec avoir bon car ce ceci cela celle celles celui cependant certain certaine ces cet cette ceux chaque chez comme comment des dedans dehors devait devrait deux doit donc dos droite déjà elles est et eta étaient étais était étant été être eu eux fait faire fois font ici il ils je juste là leur leurs lui ma maintenant mais mes mine moins mon mot même ne ni nommés notre nous nouveaux par parce parole pas personnes peut peu pièce plupart que sa sans ses seulement si sien son sont sous soyez sujet sur ta tandis tels tes ton tous tout trop très tu une valeur voie voient vont votre vous vu dis dit oui non plus petit grande grand bien toute toutes rien chose choses monsieur madame aussitôt autant autrement`
    .split(/\s+/)
    .filter(Boolean)
);

export function cleanWordText(raw: string) {
  // Whisper écrit avec l'apostrophe typographique (’) : on la ramène à ' sinon
  // « l’intérieur » devient « lintérieur » et les élisions ne sont plus vues.
  let text = raw.replace(/[‘’]/g, "'").replace(/[^\p{L}\p{N}'-]/gu, "").trim();
  // élisions : l'intérieur -> intérieur, d'avoir -> avoir
  text = text.replace(/^(l|d|j|n|s|c|m|t|qu|jusqu)[']/i, "");
  return text.replace(/[']+$/, "").trim();
}

/** Formes verbales très fréquentes: mauvaises candidates à l'illustration. */
const VERB_FORMS = new Set(
  `était étaient étais Été étais avait avaient avais ayant suis sommes sont étaient sera seront serait serais avoir étant fait faisait faisaient font dit dire dirent voit voyait voyaient vint venir prit prendre mis mettre fut fut fut devait devaient devait pouvait pouvaient voulait voulaient savait savaient allait allaient fallait semblait semblaient arrivait arrivait trouvait trouvaient pensait pensaient parlait parlaient regardait regardait répondit demanda devint restait restaient devenait passait passaient montait sortait entrait commençait continuait finissait fini commencé terminé passé resté arrivé trouvé pensé parlé regardé demandé montré décidé essayé réussi oublié cherché découvert trouvé`
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase())
);

/** Fréquence des mots significatifs (pour repérer les thèmes du texte). */
export function wordFrequencies(project: Project) {
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

const NOUN_SUFFIX = /(tion|sion|ance|ence|ité|isme|iste|euse|esse|age|ure|ade|oir|oire|aire|ège|ie|eau|elle|aille|eur|aine|ette|erie|itude|ille)$/;
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

export type WordContext = { prev: string; next: string; isSentenceStart: boolean };

/**
 * Score d'illustrabilité d'un mot: position grammaticale (déterminant devant =
 * nom, pronom devant = verbe), suffixes, fréquence, longueur, ponctuation.
 */
export function scoreWord(display: string, lower: string, freq: Map<string, number>, context: WordContext) {
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

  // Position grammaticale : après un déterminant (ou un adjectif) c'est un nom,
  // donc les pénalités de verbe ne doivent pas s'appliquer. Sans cela, des noms
  // très illustrables finissant en -re (grimoire, livre, armoire…) sont écartés.
  const looksNoun = afterDeterminer || MENT_NOUNS.has(lower) || NOUN_SUFFIX.test(lower);
  // Un mot capitalisé en pleine phrase est un nom propre (le meilleur candidat).
  const looksProperNoun = /^[A-ZÀ-Ý]/.test(display) && !context.isSentenceStart;

  if (MENT_NOUNS.has(lower)) score += 1.8;
  else if (NOUN_SUFFIX.test(lower)) score += 1.6;
  if (!looksProperNoun && (ADJECTIVE_HINTS.has(lower) || (ADJ_SUFFIX.test(lower) && !NOUN_SUFFIX.test(lower)))) score -= 2.0;
  if (ABSTRACTS.has(lower)) score -= 3.6;
  else if (/ment$/.test(lower) && !MENT_NOUNS.has(lower)) score -= 2.0;
  if (WEAK_WORDS.has(lower) && !looksNoun) score -= 2.8;
  if (VERB_FORMS.has(lower) && !looksNoun) score -= 3.2;
  if (VERB_SUFFIX.test(lower) && !looksNoun && !ADJECTIVE_HINTS.has(lower)) score -= 1.4;
  // infinitifs : « vouloir », « déverrouiller »… peu illustrables
  if (!looksNoun && /(er|ir)$/.test(lower) && lower.length >= 5) score -= 1.6;
  else if (!looksNoun && /re$/.test(lower) && lower.length >= 6) score -= 0.8;
  if (lower.length < 5) score -= 0.7;
  if (lower.includes("-")) score -= 0.8; // « Serions-nous », mots composés
  return score;
}

/** Score minimal pour qu'un mot soit jugé "illustrable". */
export const KEYWORD_MIN_SCORE = 3.5;

export type AutoSlot = { start: number; end: number; keywords: string[]; scores: number[]; top: string };

/**
 * Découpe la narration en créneaux et repère les mots illustrables de chacun:
 * noms concrets, mots propres, thèmes récurrents, et paires nom + adjectif.
 */
export function buildAutoSlots(project: Project, minDuration: number): AutoSlot[] {
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
export function pickKeyword(slot: AutoSlot, used: Set<string>) {
  for (const keyword of slot.keywords) {
    const head = keyword.toLowerCase().split(" ")[0];
    if (!used.has(keyword.toLowerCase()) && !used.has(head)) return keyword;
  }
  return slot.keywords[0] || "";
}
