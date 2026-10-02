/**
 * Calcul des largeurs de colonnes, sans DOM (testé par tests/front.test.ts).
 *
 * La règle `flex: <w> 1 <w>px` est le cœur de la disposition : les colonnes
 * visibles se partagent la place au prorata de leur largeur (facteur de
 * croissance = base), donc une colonne masquée libère vraiment sa place et une
 * fenêtre plus étroite réduit les colonnes au lieu de les faire déborder.
 */
export const MIN_COL = 250;
export const DEFAULT_W = { left: 430, center: 520, right: 420 };

/** Largeur effective d'une colonne (bornée, avec repli sur la valeur par défaut). */
export function columnWidth(name, widths = {}) {
  return Math.max(MIN_COL, Math.round(Number(widths?.[name]) || DEFAULT_W[name] || 400));
}

/** Règle flex proportionnelle d'une colonne visible. */
export function columnFlex(width) {
  return `${width} 1 ${width}px`;
}

/** Largeur + règle flex d'une colonne visible, en une seule décision testable. */
export function columnLayout(name, widths = {}) {
  const width = columnWidth(name, widths);
  return { name, width, flex: columnFlex(width) };
}
