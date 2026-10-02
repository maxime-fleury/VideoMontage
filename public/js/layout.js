import { $, $$ } from "./api.js";
import { MIN_COL, columnLayout } from "./layoutmath.js";

/**
 * Disposition de l'application.
 *
 * - largeur des colonnes ET hauteur des panneaux dans une colonne (poignées) ;
 * - panneaux masqués (menu « 🧩 Panneaux ») : une colonne vide disparaît et les
 *   voisines récupèrent la place, donc plus de vide dans l'application ;
 * - panneaux repliés ou déplacés d'une colonne à l'autre.
 *
 * Tout est mémorisé dans localStorage (clé v3, migration depuis v2).
 */
const KEY = "montagevideo.layout.v3";
const LEGACY_KEY = "montagevideo.layout.v2";
const MIN_CARD = 110;

let draggingCard = null;

function loadState() {
  let state = {};
  try {
    state = JSON.parse(localStorage.getItem(KEY) || "{}") || {};
  } catch {
    state = {};
  }
  if (!state.widths) {
    // Migration depuis la v2 : les largeurs étaient un tableau par index de colonne.
    try {
      const legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) || "{}");
      if (Array.isArray(legacy.widths)) {
        const names = ["left", "center", "right"];
        const widths = {};
        legacy.widths.forEach((value, index) => {
          if (value && names[index]) widths[names[index]] = value;
        });
        state = { ...legacy, widths };
        delete state.widths2;
      } else if (legacy.collapsed || legacy.panels) {
        state = { ...legacy };
      }
    } catch {
      // pas de disposition précédente : on part des valeurs par défaut
    }
  }
  return { widths: {}, heights: {}, collapsed: [], hidden: [], panels: {}, ...state };
}

function saveState(patch) {
  const state = { ...loadState(), ...patch };
  localStorage.setItem(KEY, JSON.stringify(state));
}

export function panelCard(id) {
  return $(`.card[data-panel="${id}"]`);
}

export function panelIds() {
  return $$(".card[data-panel]").map((card) => card.dataset.panel);
}

export function isPanelVisible(id) {
  const card = panelCard(id);
  return !!card && !card.classList.contains("panel-hidden");
}

export function initLayout() {
  const layout = $(".layout");
  if (!layout) return;
  const state = loadState();

  // --- panneaux repliés / masqués ---
  for (const card of $$(".card")) {
    const id = card.dataset.panel;
    if ((state.collapsed || []).includes(id)) card.classList.add("collapsed");
    if ((state.hidden || []).includes(id)) card.classList.add("panel-hidden");
    const button = $("[data-collapse]", card);
    if (button) button.textContent = card.classList.contains("collapsed") ? "▸" : "▾";
  }

  if (state.panels) restorePanels(state.panels);

  // --- replier / déplier ---
  for (const button of $$("[data-collapse]")) {
    button.addEventListener("click", () => {
      const card = button.closest(".card");
      if (!card) return;
      card.classList.toggle("collapsed");
      button.textContent = card.classList.contains("collapsed") ? "▸" : "▾";
      persistCollapsed();
      rebuildLayout();
    });
  }

  // --- déplacement des panneaux (poignée ⠿) ---
  for (const card of $$(".card")) {
    const handle = $(".drag-handle", card);
    if (!handle) continue;
    handle.draggable = true;
    handle.addEventListener("dragstart", (e) => {
      draggingCard = card;
      card.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", card.dataset.panel || "panel");
    });
    handle.addEventListener("dragend", () => {
      card.classList.remove("dragging");
      for (const col of $$(".col")) col.classList.remove("drop-target");
      draggingCard = null;
      persistPanels();
      rebuildLayout();
    });
  }

  for (const col of $$(".col")) {
    col.addEventListener("dragover", (e) => {
      if (!draggingCard) return;
      e.preventDefault();
      col.classList.add("drop-target");
    });
    col.addEventListener("dragleave", () => col.classList.remove("drop-target"));
    col.addEventListener("drop", (e) => {
      if (!draggingCard) return;
      e.preventDefault();
      col.classList.remove("drop-target");
      const cards = $$(".card", col).filter((card) => card !== draggingCard);
      const after = cards.find((card) => {
        const rect = card.getBoundingClientRect();
        return e.clientY < rect.top + rect.height / 2;
      });
      if (after) col.insertBefore(draggingCard, after);
      else col.append(draggingCard);
    });
  }

  window.addEventListener("resize", () => {
    clampHeights();
    rebuildLayout();
  });

  rebuildLayout();
}

/** Affiche ou masque un panneau (menu « Panneaux »). */
export function showPanel(id, visible) {
  const card = panelCard(id);
  if (!card) return;
  card.classList.toggle("panel-hidden", !visible);
  const hidden = $$(".card.panel-hidden").map((c) => c.dataset.panel);
  saveState({ hidden });
  rebuildLayout();
}

export function togglePanel(id) {
  showPanel(id, !isPanelVisible(id));
}

export function collapsePanel(id, collapsed) {
  const card = panelCard(id);
  if (!card) return;
  card.classList.toggle("collapsed", collapsed !== false);
  const button = $("[data-collapse]", card);
  if (button) button.textContent = card.classList.contains("collapsed") ? "▸" : "▾";
  persistCollapsed();
  rebuildLayout();
}

export function resetLayout() {
  localStorage.removeItem(KEY);
  location.reload();
}

export function resetHeights() {
  saveState({ heights: {} });
  rebuildLayout();
}

// ---------------------------------------------------------------------------
// Colonnes : visibilité, poignées horizontales et verticales
// ---------------------------------------------------------------------------

function visibleCards(col) {
  return $$(".card", col).filter((card) => !card.classList.contains("panel-hidden"));
}

/** Reconstruit splitters et hauteurs après tout changement de panneaux. */
export function rebuildLayout() {
  const layout = $(".layout");
  if (!layout) return;
  const cols = $$(".col", layout);

  // Une colonne sans carte visible disparaît complètement.
  for (const col of cols) col.hidden = visibleCards(col).length === 0;

  applyWidths();
  applyHeights();

  // Poignées verticales : entre deux panneaux visibles d'une même colonne.
  for (const splitter of $$(".splitter-v", layout)) splitter.remove();
  for (const col of cols) {
    if (col.hidden) continue;
    const cards = visibleCards(col);
    for (let i = 0; i < cards.length - 1; i++) {
      const upper = cards[i];
      const lower = cards[i + 1];
      if (upper.classList.contains("collapsed") && lower.classList.contains("collapsed")) continue;
      const splitter = document.createElement("div");
      splitter.className = "splitter splitter-v";
      splitter.title = "Glisser pour redimensionner la hauteur";
      upper.after(splitter);
      wireVerticalSplitter(splitter, col, upper, lower);
    }
  }

  // Poignées horizontales : une seule entre chaque paire de colonnes visibles.
  for (const splitter of $$(".splitter-h", layout)) splitter.remove();
  const visible = cols.filter((col) => !col.hidden);
  for (let i = 0; i < visible.length - 1; i++) {
    const left = visible[i];
    const right = visible[i + 1];
    const splitter = document.createElement("div");
    splitter.className = "splitter splitter-h";
    splitter.title = "Glisser pour redimensionner la colonne";
    left.after(splitter);
    wireHorizontalSplitter(splitter, left, right);
  }
}

function wireHorizontalSplitter(splitter, left, right) {
  splitter.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    splitter.classList.add("active");
    try {
      splitter.setPointerCapture(event.pointerId);
    } catch {}
    const startX = event.clientX;
    const startLeft = left.getBoundingClientRect().width;
    const startRight = right.getBoundingClientRect().width;
    // Les autres colonnes sont figées pendant le glissement : seules les deux
    // voisines de la poignée bougent, les largeurs gardent donc leur sens.
    const frozen = $$(".col")
      .filter((col) => !col.hidden && col !== left && col !== right)
      .map((col) => [col, col.getBoundingClientRect().width]);

    const move = (e) => {
      const delta = e.clientX - startX;
      const nextLeft = Math.max(MIN_COL, startLeft + delta);
      const nextRight = Math.max(MIN_COL, startRight - delta);
      left.style.flex = `0 0 ${nextLeft}px`;
      right.style.flex = `0 0 ${nextRight}px`;
      for (const [col, width] of frozen) col.style.flex = `0 0 ${width}px`;
      document.body.style.cursor = "col-resize";
    };
    const up = () => {
      splitter.classList.remove("active");
      document.body.style.cursor = "";
      splitter.removeEventListener("pointermove", move);
      splitter.removeEventListener("pointerup", up);
      // Les colonnes masquées gardent leur ancienne largeur : on ne mémorise que les visibles.
      const widths = { ...loadState().widths };
      for (const col of $$(".col")) {
        if (col.hidden) continue;
        widths[col.dataset.col] = Math.round(col.getBoundingClientRect().width);
      }
      saveState({ widths });
      window.dispatchEvent(new Event("resize"));
    };
    splitter.addEventListener("pointermove", move);
    splitter.addEventListener("pointerup", up);
  });
}

function wireVerticalSplitter(splitter, col, upper, lower) {
  splitter.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    splitter.classList.add("active");
    try {
      splitter.setPointerCapture(event.pointerId);
    } catch {}
    const startY = event.clientY;
    const startUpper = upper.getBoundingClientRect().height;
    const startLower = lower.getBoundingClientRect().height;
    const total = startUpper + startLower;

    const move = (e) => {
      const delta = e.clientY - startY;
      const nextUpper = Math.max(MIN_CARD, Math.min(total - MIN_CARD, startUpper + delta));
      const nextLower = total - nextUpper;
      upper.style.flex = `0 0 ${nextUpper}px`;
      lower.style.flex = `0 0 ${nextLower}px`;
      document.body.style.cursor = "row-resize";
    };
    const up = () => {
      splitter.classList.remove("active");
      document.body.style.cursor = "";
      splitter.removeEventListener("pointermove", move);
      splitter.removeEventListener("pointerup", up);
      const heights = { ...loadState().heights };
      heights[upper.dataset.panel] = Math.round(upper.getBoundingClientRect().height);
      heights[lower.dataset.panel] = Math.round(lower.getBoundingClientRect().height);
      saveState({ heights });
      window.dispatchEvent(new Event("resize"));
    };
    splitter.addEventListener("pointermove", move);
    splitter.addEventListener("pointerup", up);
  });
}

/**
 * Applique les largeurs mémorisées de façon proportionnelle.
 *
 * `flex: <largeur> 1 <largeur>px` : les colonnes visibles se partagent toute la
 * place disponible au prorata de leur largeur. Une colonne masquée libère donc
 * vraiment sa place (plus de vide dans l'application) et une fenêtre plus
 * étroite réduit les colonnes au lieu de les faire déborder.
 */
function applyWidths() {
  const widths = loadState().widths || {};
  for (const col of $$(".col")) {
    if (col.hidden) {
      col.style.removeProperty("flex");
      continue;
    }
    col.style.flex = columnLayout(col.dataset.col, widths).flex;
  }
}

/** Applique les hauteurs mémorisées (les autres cartes se partagent le reste). */
function applyHeights() {
  const heights = loadState().heights || {};
  for (const card of $$(".card")) {
    if (card.classList.contains("panel-hidden") || card.classList.contains("collapsed")) {
      card.style.removeProperty("flex");
      continue;
    }
    const height = Number(heights[card.dataset.panel]);
    if (height > 0) card.style.flex = `0 0 ${Math.round(height)}px`;
    else card.style.removeProperty("flex");
  }
}

/** Si la fenêtre rétrécit, on relâche les hauteurs mémorisées qui ne tiennent plus. */
function clampHeights() {
  const heights = { ...loadState().heights };
  let changed = false;
  for (const col of $$(".col")) {
    if (col.hidden) continue;
    const cards = visibleCards(col).filter((card) => !card.classList.contains("collapsed"));
    const fixed = cards.filter((card) => Number(heights[card.dataset.panel]) > 0);
    if (fixed.length < 2) continue;
    const available = col.getBoundingClientRect().height;
    const sum = fixed.reduce((acc, card) => acc + Number(heights[card.dataset.panel]), 0);
    const flexible = cards.length - fixed.length;
    if (sum <= available - flexible * MIN_CARD) continue;
    // On libère les plus grandes hauteurs jusqu'à ce que tout rentre.
    for (const card of fixed.sort((a, b) => Number(heights[b.dataset.panel]) - Number(heights[a.dataset.panel]))) {
      if (sum <= available - flexible * MIN_CARD) break;
      delete heights[card.dataset.panel];
      changed = true;
    }
  }
  if (changed) saveState({ heights });
}

function restorePanels(panels) {
  for (const [colName, ids] of Object.entries(panels)) {
    const col = $(`.col[data-col="${colName}"]`);
    if (!col) continue;
    for (const id of ids) {
      const card = $(`.card[data-panel="${id}"]`);
      if (card) col.append(card);
    }
  }
}

export function persistPanels() {
  const panels = {};
  for (const col of $$(".col")) {
    panels[col.dataset.col] = $$(".card", col).map((card) => card.dataset.panel);
  }
  saveState({ panels });
}

function persistCollapsed() {
  const collapsed = $$(".card.collapsed").map((card) => card.dataset.panel);
  saveState({ collapsed });
}
