import { S, emit, clips, sourceById, adoptProject } from "./state.js";
import { $, el, api, toast, openModal, clamp, fmtTime, newId } from "./api.js";

const PROVIDERS = [
  ["web", "Web (photos du net)"],
  ["openverse", "Openverse (libre)"],
  ["wikimedia", "Wikimedia"],
];

function thumbUrl(result) {
  const url = result.thumb || result.url;
  return `/api/imgproxy?url=${encodeURIComponent(url)}${
    result.pageUrl ? `&referer=${encodeURIComponent(result.pageUrl)}` : ""
  }`;
}

async function search(query, provider, count = 12) {
  const data = await api(`/api/projects/${S.project.id}/search`, {
    method: "POST",
    body: { query, provider, count },
  });
  return data.results || [];
}

export async function placeImage(result, { keyword, start, duration, replaceClipId, provider }) {
  const data = await api(`/api/projects/${S.project.id}/add-image`, {
    method: "POST",
    body: {
      url: result.url,
      // La vignette déjà affichée sert de repli: elle est (presque) toujours téléchargeable.
      fallbackUrl: result.thumb && result.thumb !== result.url ? result.thumb : undefined,
      referer: result.pageUrl,
      keyword,
      provider: result.provider || provider,
      start,
      duration,
    },
  });
  let project = data.project;
  if (replaceClipId) {
    const previous = (S.project.videoTrack || []).find((c) => c.id === replaceClipId);
    if (previous) {
      project.videoTrack = project.videoTrack
        .map((clip) =>
          clip.id === data.clip.id
            ? { ...clip, start: previous.start, duration: previous.duration, effect: previous.effect }
            : clip
        )
        .filter((clip) => clip.id !== replaceClipId);
      const res = await api(`/api/projects/${S.project.id}/update`, {
        method: "POST",
        body: { videoTrack: project.videoTrack },
      });
      project = res.project;
    }
  }
  adoptProject(project);
  emit("project-external", project);
  return data.clip;
}

/**
 * Choisit une illustration parmi 3 propositions pour un mot / une expression.
 * - replaceClipId : remplace l'image d'un clip existant (durée et effets conservés)
 * - slot : active l'option « plusieurs illustrations » sur le créneau
 */
export function openIllustrationPicker({
  keyword,
  start = 0,
  duration = 3,
  replaceClipId = null,
  slot = null,
  count = 3,
  title = null,
}) {
  // Une valeur mémorisée d'une ancienne version peut ne plus exister → repli sur « web ».
  let provider = PROVIDERS.some(([value]) => value === S.search.provider) ? S.search.provider : "web";
  let results = [];
  let loading = false;
  const modal = el("div");
  let close = null;

  const grid = el("div", { class: "proposal-grid" });
  const status = el("div", { class: "muted", style: { fontSize: "12px", minHeight: "16px" } });

  const render = () => {
    grid.innerHTML = "";
    if (loading) {
      grid.append(el("div", { class: "muted", html: '<span class="spinner"></span> Recherche…' }));
      return;
    }
    if (!results.length) {
      grid.append(el("div", { class: "muted", text: "Aucun résultat — essaie une autre formulation." }));
      return;
    }
    results.slice(0, count).forEach((result, index) => {
      const card = el("div", { class: "proposal", title: result.title || "" }, [
        el("div", { class: "rank", text: String(index + 1) }),
        el("img", { src: thumbUrl(result), loading: "lazy", alt: result.title || "" }),
        el("div", { class: "cap", text: result.title || result.provider }),
      ]);
      card.addEventListener("click", async () => {
        try {
          status.textContent = "Téléchargement…";
          await placeImage(result, { keyword, start, duration, replaceClipId, provider });
          toast(`Illustration placée à ${fmtTime(start)}`, "ok");
          close?.();
        } catch (e) {
          toast(`Ajout impossible : ${e.message}`, "error");
          status.textContent = "";
        }
      });
      grid.append(card);
    });
  };

  const run = async (query) => {
    loading = true;
    status.textContent = "";
    render();
    try {
      results = await search(query, provider, 12);
      if (!results.length) status.textContent = "Rien trouvé pour cette recherche.";
    } catch (e) {
      results = [];
      status.textContent = `Recherche impossible : ${e.message}`;
    }
    loading = false;
    render();
  };

  const queryInput = el("input", { type: "text", value: keyword || "", placeholder: "mot-clé, expression…" });
  const providerSelect = el("select", {}, PROVIDERS.map(([value, label]) => el("option", { value, text: label })));
  providerSelect.value = provider;
  providerSelect.addEventListener("change", () => {
    provider = providerSelect.value;
    S.search.provider = provider;
    run(queryInput.value.trim());
  });
  const searchForm = el("form", { class: "search-form" }, [
    queryInput,
    providerSelect,
    el("button", { class: "primary", type: "submit", text: "Proposer 3" }),
  ]);
  searchForm.addEventListener("submit", (e) => {
    e.preventDefault();
    run(queryInput.value.trim() || keyword);
  });

  const slotRange = slot || { start, end: start + duration };
  const variantButton =
    slotRange.end - slotRange.start > 1.2
      ? el("button", {
          text: `➕ Plusieurs illustrations sur ce passage (${Math.max(1, Math.round((slotRange.end - slotRange.start) / 3))})`,
          title: "Répartit 3 images différentes sur tout le créneau",
          onclick: async () => {
            if (results.length < 2) return toast("Pas assez de résultats pour varier", "error");
            const list = results.slice(0, 3);
            const slice = (slotRange.end - slotRange.start) / list.length;
            try {
              status.textContent = "Ajout des variantes…";
              for (let i = 0; i < list.length; i++) {
                await placeImage(list[i], {
                  keyword,
                  start: slotRange.start + i * slice,
                  duration: slice + 0.6,
                  replaceClipId: null,
                  provider,
                });
              }
              toast(`${list.length} illustrations réparties sur le passage`, "ok");
              close?.();
            } catch (e) {
              toast(`Ajout impossible : ${e.message}`, "error");
            }
          },
        })
      : null;

  const urlInput = el("input", { type: "text", placeholder: "…ou colle une URL d'image" });
  const urlForm = el("form", { class: "search-form", style: { marginTop: "10px" } }, [
    urlInput,
    el("button", { type: "submit", text: "Ajouter" }),
  ]);
  urlForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await placeImage({ url: urlInput.value.trim(), provider: "url" }, { keyword, start, duration, replaceClipId, provider });
      close?.();
    } catch (error) {
      toast(`Ajout impossible : ${error.message}`, "error");
    }
  });

  modal.append(
    el("h2", { text: title || `🖼️ Illustration pour « ${keyword || "…"} »` }),
    el("div", {
      class: "muted",
      style: { fontSize: "12px", marginBottom: "10px" },
      text: replaceClipId
        ? "Choisis une nouvelle image : elle remplacera celle du clip (mêmes durée et effets)."
        : `Clique sur une proposition pour la placer dans la vidéo à ${fmtTime(start)}.`,
    }),
    searchForm,
    status,
    grid,
    el("div", { class: "panel-actions" }, [variantButton].filter(Boolean)),
    el("div", { class: "divider" }),
    urlForm,
    el("div", { class: "footer" }, [el("button", { text: "Fermer", onclick: () => close?.() })])
  );

  render();
  run(keyword);
  close = openModal(() => modal);
}

/** Éditeur d'image (recadrage, rotation, filtres, fond) avec aperçu live. */
export function openImageEditor(source, { onDone, keyword } = {}) {
  if (!source) return;
  const ops = {
    zoom: 1,
    focusX: 0.5,
    focusY: 0.5,
    rotate: 0,
    flipH: false,
    flipV: false,
    brightness: 0,
    contrast: 1,
    saturation: 1,
    gamma: 1,
    blur: 0,
    grayscale: false,
    sepia: false,
    vignette: false,
    removeBackground: false,
    bgColor: "#ffffff",
    bgSimilarity: 0.12,
    bgBlend: 0.05,
  };

  const image = el("img", { src: source.url, style: { width: "100%", height: "100%", objectFit: "contain" } });
  const stage = el("div", { class: "editor-stage" }, [image]);
  const status = el("div", { class: "muted", style: { fontSize: "12px" } });
  let close = null;

  const update = () => {
    const bits = [];
    if (ops.flipH) bits.push("scaleX(-1)");
    if (ops.flipV) bits.push("scaleY(-1)");
    const transforms = [`scale(${ops.zoom})`];
    if (bits.length) transforms.push(...bits);
    const shiftX = (0.5 - ops.focusX) * 100 * ops.zoom;
    const shiftY = (0.5 - ops.focusY) * 100 * ops.zoom;
    image.style.transform = `translate(${shiftX}%, ${shiftY}%) ${transforms.join(" ")} rotate(${ops.rotate}deg)`;
    const filters = [];
    if (ops.brightness) filters.push(`brightness(${1 + ops.brightness})`);
    if (ops.contrast !== 1) filters.push(`contrast(${ops.contrast})`);
    if (ops.saturation !== 1) filters.push(`saturate(${ops.saturation})`);
    if (ops.grayscale) filters.push("grayscale(1)");
    if (ops.sepia) filters.push("sepia(1)");
    if (ops.blur) filters.push(`blur(${ops.blur}px)`);
    image.style.filter = filters.join(" ") || "none";
  };

  const slider = (label, key, min, max, step, format = (v) => v) => {
    const input = el("input", { type: "range", min, max, step, value: String(ops[key]) });
    const value = el("span", { class: "val", text: format(ops[key]) });
    input.addEventListener("input", () => {
      ops[key] = Number(input.value);
      value.textContent = format(ops[key]);
      update();
    });
    return el("div", { class: "prop-row" }, [el("span", { text: label }), input, value]);
  };
  const toggle = (label, key) => {
    const input = el("input", { type: "checkbox", checked: !!ops[key] });
    input.addEventListener("change", () => {
      ops[key] = input.checked;
      update();
    });
    return el("div", { class: "prop-row" }, [el("span", { text: label }), input]);
  };

  // pipette : clic sur l'aperçu pour choisir la couleur de fond à détourer
  stage.addEventListener("click", (event) => {
    if (!ops.removeBackground) return;
    const rect = image.getBoundingClientRect();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const x = clamp(Math.round(((event.clientX - rect.left) / rect.width) * canvas.width), 0, canvas.width - 1);
    const y = clamp(Math.round(((event.clientY - rect.top) / rect.height) * canvas.height), 0, canvas.height - 1);
    try {
      const data = ctx.getImageData(x, y, 1, 1).data;
      ops.bgColor = `#${[data[0], data[1], data[2]].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
      colorInput.value = ops.bgColor;
      status.textContent = `Fond à détourer : ${ops.bgColor}`;
    } catch {
      status.textContent = "Impossible de lire la couleur (image distante).";
    }
  });

  const colorInput = el("input", { type: "color", value: ops.bgColor, style: { width: "54px", padding: "2px" } });
  colorInput.addEventListener("input", () => {
    ops.bgColor = colorInput.value;
  });

  const apply = async () => {
    applyButton.disabled = true;
    status.innerHTML = '<span class="spinner"></span> Rendu de l\'image…';
    try {
      const data = await api(`/api/projects/${S.project.id}/edit-image`, {
        method: "POST",
        body: { sourceId: source.id, ops, keyword: keyword || source.meta?.keyword || "" },
      });
      adoptProject(data.project);
      emit("project-external", data.project);
      toast("Image retouchée ✓", "ok");
      onDone?.(data.source);
      close?.();
    } catch (e) {
      status.textContent = `Échec : ${e.message}`;
      applyButton.disabled = false;
    }
  };
  const applyButton = el("button", { class: "primary", text: "✨ Appliquer la retouche", onclick: apply });

  const modal = el("div", { class: "modal-editor" }, [
    el("h2", { text: "🪄 Retoucher l'image" }),
    el("div", { class: "muted", style: { fontSize: "12px", marginBottom: "10px" }, text: "L'aperçu est approximatif ; le rendu final est calculé par FFmpeg." }),
    stage,
    el("div", { class: "divider" }),
    el("div", { class: "ctrl-grid" }, [
      el("div", { class: "ctrl" }, [slider("Zoom", "zoom", 1, 3, 0.01, (v) => `×${Number(v).toFixed(2)}`), slider("Cadrage horizontal", "focusX", 0, 1, 0.01, (v) => `${Math.round(v * 100)} %`), slider("Cadrage vertical", "focusY", 0, 1, 0.01, (v) => `${Math.round(v * 100)} %`)]),
      el("div", { class: "ctrl" }, [slider("Rotation", "rotate", -180, 180, 1, (v) => `${v}°`), slider("Luminosité", "brightness", -0.6, 0.6, 0.02, (v) => Number(v).toFixed(2)), slider("Contraste", "contrast", 0.4, 2, 0.02, (v) => Number(v).toFixed(2))]),
      el("div", { class: "ctrl" }, [slider("Saturation", "saturation", 0, 2.5, 0.02, (v) => Number(v).toFixed(2)), slider("Flou", "blur", 0, 20, 0.5, (v) => `${v} px`), slider("Gamma", "gamma", 0.4, 2.4, 0.02, (v) => Number(v).toFixed(2))]),
    ]),
    el("div", { class: "ctrl-grid" }, [
      el("div", { class: "ctrl" }, [toggle("Miroir horizontal", "flipH"), toggle("Miroir vertical", "flipV")]),
      el("div", { class: "ctrl" }, [toggle("Noir et blanc", "grayscale"), toggle("Sépia", "sepia")]),
      el("div", { class: "ctrl" }, [toggle("Vignettage", "vignette"), toggle("Détourer un fond uni", "removeBackground")]),
    ]),
    el("div", { class: "prop-row" }, [
      el("span", { text: "Couleur du fond à retirer (clique dans l'aperçu pour la pipeter)" }),
      colorInput,
    ]),
    el("div", { class: "row" }, [slider("Tolérance du détourage", "bgSimilarity", 0.02, 0.5, 0.01, (v) => Number(v).toFixed(2))]),
    status,
    el("div", { class: "footer" }, [
      el("button", { text: "Fermer", onclick: () => close?.() }),
      el("button", {
        text: "↺ Réinitialiser",
        onclick: () => {
          Object.assign(ops, { zoom: 1, focusX: 0.5, focusY: 0.5, rotate: 0, flipH: false, flipV: false, brightness: 0, contrast: 1, saturation: 1, gamma: 1, blur: 0, grayscale: false, sepia: false, vignette: false, removeBackground: false });
          update();
        },
      }),
      applyButton,
    ]),
  ]);
  close = openModal(() => modal);
  update();
}
