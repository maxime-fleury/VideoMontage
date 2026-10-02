import { $, $$ } from "./api.js";

const KEY = "montagevideo.layout.v2";
const MIN_COL = 250;
let draggingCard = null;

function loadState() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "{}");
  } catch {
    return {};
  }
}
function saveState(patch) {
  const state = { ...loadState(), ...patch };
  localStorage.setItem(KEY, JSON.stringify(state));
}

export function initLayout() {
  const layout = $(".layout");
  if (!layout) return;
  const cols = $$(".col", layout);

  const state = loadState();
  if (Array.isArray(state.widths)) {
    cols.forEach((col, i) => {
      if (state.widths[i]) col.style.flex = `0 0 ${state.widths[i]}px`;
    });
  }
  if (Array.isArray(state.collapsed)) {
    $$(".card").forEach((card) => {
      if (state.collapsed.includes(card.dataset.panel)) card.classList.add("collapsed");
    });
  }
  if (state.panels) restorePanels(state.panels);

  // --- splitters ---
  $$(".splitter", layout).forEach((splitter, index) => {
    splitter.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      splitter.classList.add("active");
      // La capture peut échouer (pointerId déjà relâché) : le glissement doit continuer.
      try {
        splitter.setPointerCapture(event.pointerId);
      } catch {}
      splitter.style.touchAction = "none";
      const left = cols[index];
      const right = cols[index + 1];
      const startX = event.clientX;
      const startLeft = left.getBoundingClientRect().width;
      const startRight = right.getBoundingClientRect().width;

      const move = (e) => {
        const delta = e.clientX - startX;
        const nextLeft = Math.max(MIN_COL, startLeft + delta);
        const nextRight = Math.max(MIN_COL, startRight - delta);
        left.style.flex = `0 0 ${nextLeft}px`;
        right.style.flex = `0 0 ${nextRight}px`;
        document.body.style.cursor = "col-resize";
      };
      const up = () => {
        splitter.classList.remove("active");
        document.body.style.cursor = "";
        splitter.removeEventListener("pointermove", move);
        splitter.removeEventListener("pointerup", up);
        saveState({ widths: cols.map((col) => Math.round(col.getBoundingClientRect().width)) });
        window.dispatchEvent(new Event("resize"));
      };
      splitter.addEventListener("pointermove", move);
      splitter.addEventListener("pointerup", up);
    });
  });

  // --- déplacement des panneaux ---
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
      for (const col of cols) col.classList.remove("drop-target");
      draggingCard = null;
      persistPanels();
      window.dispatchEvent(new Event("resize"));
    });
  }

  for (const col of cols) {
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

  // --- replier / déplier ---
  for (const button of $$("[data-collapse]")) {
    button.addEventListener("click", () => {
      const card = button.closest(".card");
      card.classList.toggle("collapsed");
      button.textContent = card.classList.contains("collapsed") ? "▸" : "▾";
      persistCollapsed();
      window.dispatchEvent(new Event("resize"));
    });
    const card = button.closest(".card");
    if (card?.classList.contains("collapsed")) button.textContent = "▸";
  }

  $("#btnLayoutReset")?.addEventListener("click", () => {
    localStorage.removeItem(KEY);
    location.reload();
  });
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

function persistPanels() {
  const panels = {};
  for (const col of $$(".col")) {
    panels[col.dataset.col] = $$(".card", col).map((card) => card.dataset.panel);
  }
  saveState({ panels });
}

function persistCollapsed() {
  const collapsed = $$(".card").filter((card) => card.classList.contains("collapsed")).map((card) => card.dataset.panel);
  saveState({ collapsed });
}
