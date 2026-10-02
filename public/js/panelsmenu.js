import { $, $$, el } from "./api.js";
import { S, on, emit } from "./state.js";
import { panelIds, isPanelVisible, showPanel, resetLayout, resetHeights } from "./layout.js";
import {
  AUDIO_KINDS,
  MAX_OVERLAY_LAYERS,
  addAudioTrack,
  addText,
  addVideoLayer,
  audioKindInfo,
  moveVideoLayer,
  removeAudioTrack,
  removeText,
  removeVideoLayer,
  renameAudioTrack,
  renameVideoLayer,
  toggleAudioMute,
  toggleVideoLayerHidden,
} from "./tracks.js";

/**
 * Menu « 🧩 Panneaux » : cases à cocher des panneaux + gestion des pistes
 * (vidéo, audio, textes). C'est le seul endroit où l'on ajoute/retire des pistes.
 */

let open = false;

export function initPanelsMenu() {
  const button = $("#btnPanels");
  const menu = $("#panelsMenu");
  if (!button || !menu) return;

  button.addEventListener("click", (event) => {
    event.stopPropagation();
    setOpen(!open);
  });
  menu.addEventListener("click", (event) => event.stopPropagation());
  document.addEventListener("click", () => setOpen(false));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && open) setOpen(false);
  });

  on("project", () => open && render());
  on("render", () => open && render());
  on("panels", () => open && render());
  render();
}

function setOpen(next) {
  open = next;
  const menu = $("#panelsMenu");
  const button = $("#btnPanels");
  if (!menu || !button) return;
  menu.hidden = !open;
  button.classList.toggle("active", open);
  if (open) render();
}

function sectionTitle(text, extra) {
  return el("div", { class: "menu-section" }, [el("span", { text }), extra || el("span")].filter(Boolean));
}

function row(children, className = "menu-row") {
  return el("div", { class: className }, children);
}

function smallButton(text, title, onclick, disabled = false) {
  return el("button", { class: "ghost icon menu-icon", text, title, onclick, disabled: disabled ? true : undefined });
}

function nameInput(value, onRename) {
  const input = el("input", {
    class: "menu-input",
    type: "text",
    value,
    title: "Renommer",
    onchange: (e) => onRename(e.target.value),
    onkeydown: (e) => {
      if (e.key === "Enter") e.target.blur();
    },
  });
  return input;
}

function render() {
  const menu = $("#panelsMenu");
  if (!menu) return;
  menu.innerHTML = "";

  // --- panneaux ---
  const panelsHead = sectionTitle("Panneaux", el("span", { class: "muted", text: "cases à cocher" }));
  menu.append(panelsHead);
  for (const id of panelIds()) {
    const card = $(`.card[data-panel="${id}"]`);
    const name = card?.dataset.panelName || id;
    const box = el("input", {
      type: "checkbox",
      ...(isPanelVisible(id) ? { checked: true } : {}),
      onchange: (e) => showPanel(id, e.target.checked),
    });
    menu.append(
      el("label", { class: "menu-row clickable" }, [box, el("span", { text: name })])
    );
  }

  // --- pistes vidéo (superpositions) ---
  const layers = S.project?.overlayLayers || [];
  menu.append(
    sectionTitle(
      "Pistes vidéo",
      el("button", {
        class: "ghost menu-add",
        text: "＋",
        title: layers.length >= MAX_OVERLAY_LAYERS ? `${MAX_OVERLAY_LAYERS} pistes maximum` : "Ajouter une piste vidéo (superpositions)",
        disabled: layers.length >= MAX_OVERLAY_LAYERS,
        onclick: () => addVideoLayer(),
      })
    )
  );
  if (!layers.length) {
    menu.append(el("div", { class: "menu-hint", text: "Une seule piste vidéo pour l'instant. Ajoute « Vidéo 2 » pour superposer une image ou une vidéo." }));
  }
  layers.forEach((layer, index) => {
    menu.append(
      row([
        smallButton(layer.hidden ? "🙈" : "👁", layer.hidden ? "Masquée à l'export" : "Visible à l'export", () => toggleVideoLayerHidden(layer.id)),
        nameInput(layer.name, (value) => renameVideoLayer(layer.id, value)),
        el("span", { class: "muted menu-count", text: `${layer.clips.length}` }),
        smallButton("↑", "Monter d'un cran", () => moveVideoLayer(layer.id, -1), index === 0),
        smallButton("↓", "Descendre d'un cran", () => moveVideoLayer(layer.id, 1), index === layers.length - 1),
        smallButton("✕", "Supprimer la piste", () => removeVideoLayer(layer.id)),
      ])
    );
  });

  // --- pistes audio ---
  menu.append(
    sectionTitle(
      "Pistes audio",
      el("select", {
        class: "menu-select",
        title: "Ajouter une piste audio",
        onchange: (e) => {
          addAudioTrack(e.target.value);
          e.target.value = "";
        },
      }, [
        el("option", { value: "", text: "＋" }),
        ...AUDIO_KINDS.map((kind) => el("option", { value: kind.id, text: `＋ ${kind.icon} ${kind.label}` })),
      ])
    )
  );
  for (const track of S.project?.audioTracks || []) {
    const info = audioKindInfo(track.kind);
    menu.append(
      row([
        smallButton(track.muted ? "🔇" : info.icon, track.muted ? "Réactiver" : "Couper", () => toggleAudioMute(track.id)),
        nameInput(track.name, (value) => renameAudioTrack(track.id, value)),
        el("span", { class: "muted menu-count", text: `${track.clips?.length || 0}` }),
        smallButton("✕", "Supprimer la piste", () => removeAudioTrack(track.id)),
      ])
    );
  }

  // --- textes libres ---
  const texts = S.project?.texts || [];
  menu.append(
    sectionTitle(
      "Textes",
      el("button", {
        class: "ghost menu-add",
        text: "＋",
        title: "Ajouter un texte à la tête de lecture",
        onclick: () => addText({ start: S.playhead }),
      })
    )
  );
  if (!texts.length) {
    menu.append(el("div", { class: "menu-hint", text: "Aucun texte libre. Ajoute-en un, puis déplace-le à la souris sur l'aperçu." }));
  }
  texts.forEach((text) => {
    menu.append(
      row([
        smallButton("🎯", "Aller à ce texte", () => emit("seek", Math.max(0, text.start))),
        el("span", { class: "menu-name", text: (text.text || "").slice(0, 26) || "(vide)", title: text.text }),
        smallButton("✎", "Modifier", () => emit("edit-text", { id: text.id })),
        smallButton("✕", "Supprimer", () => removeText(text.id)),
      ])
    );
  });

  // --- disposition ---
  menu.append(el("div", { class: "divider" }));
  menu.append(
    row(
      [
        el("button", { class: "ghost", text: "Tout afficher", onclick: () => $$(".card").forEach((card) => showPanel(card.dataset.panel, true)) }),
        el("button", { class: "ghost", text: "Hauteurs auto", title: "Relâche les hauteurs fixées à la main", onclick: () => resetHeights() }),
        el("button", { class: "ghost", text: "Réinitialiser", title: "Disposition d'origine", onclick: () => resetLayout() }),
      ],
      "menu-actions"
    )
  );
}
