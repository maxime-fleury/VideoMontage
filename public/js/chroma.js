/**
 * Clé chromatique : les mêmes calculs que ffmpeg, pour que l'aperçu montre
 * réellement ce que le rendu produira.
 *
 * - `colorkey` (libavfilter/vf_colorkey.c) : distance euclidienne normalisée
 *   entre le pixel et la couleur-clé, puis rampe `(diff - similarité) / mélange`.
 * - `despill` (libavfilter/vf_despill.c) : retire la couleur dominante qui
 *   déborde sur les contours (mixture 0.5, expansion 0 par défaut).
 *
 * Module sans DOM : le rendu (ffmpeg) et l'aperçu (canvas) partagent donc la
 * même définition de ce qui devient transparent.
 */

/** #rrggbb (ou #rgb) → { r, g, b } dans 0..255. */
export function hexToRgb(hex) {
  let value = String(hex || "").trim().replace(/^#/, "");
  if (value.length === 3) value = value.split("").map((c) => c + c).join("");
  if (!/^[0-9a-f]{6}$/i.test(value)) return { r: 0, g: 255, b: 0 };
  const int = parseInt(value, 16);
  return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 };
}

export function rgbToHex({ r, g, b }) {
  const part = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${part(r)}${part(g)}${part(b)}`;
}

/** L'écran est-il bleu ? (sinon vert) — sert au type de despill, comme au rendu. */
export function isBlueScreen(key) {
  return key.b > key.g;
}

/**
 * Opacité d'un pixel selon `colorkey` : 0 = transparent, 1 = opaque.
 * `blend` = 0 → seuil net (comportement de ffmpeg quand le mélange est nul).
 */
export function keyAlpha(r, g, b, key, similarity, blend) {
  const dr = r - key.r;
  const dg = g - key.g;
  const db = b - key.b;
  const diff = Math.sqrt((dr * dr + dg * dg + db * db) / (255 * 255 * 3));
  if (blend > 0.00001) {
    const alpha = (diff - similarity) / blend;
    return alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
  }
  return diff > similarity ? 1 : 0;
}

/**
 * Retire le reflet de l'écran (despill) : renvoie les canaux corrigés.
 * Reproduit `despill=type=green|blue:mix=0.5:expand=0`.
 */
export function despill(r, g, b, key, mix = 0.5, expand = 0) {
  const factor = (1 - mix) * (1 - expand);
  const [red, green, blue] = [r / 255, g / 255, b / 255];
  const spill = isBlueScreen(key)
    ? Math.max(blue - (red * mix + green * factor), 0)
    : Math.max(green - (red * mix + blue * factor), 0);
  // échelles par défaut : vert -1, autres 0 (le canal de l'écran est réduit du spill)
  return {
    r: Math.max(0, Math.min(255, red * 255)),
    g: Math.max(0, Math.min(255, (green - (isBlueScreen(key) ? 0 : spill)) * 255)),
    b: Math.max(0, Math.min(255, (blue - (isBlueScreen(key) ? spill : 0)) * 255)),
  };
}

/**
 * Applique la clé chromatique à un `ImageData` (modifié sur place).
 * Les pixels transparents deviennent noirs : ffmpeg ne garde pas la couleur sous
 * un alpha nul, et cela évite les halos de couleur du navigateur.
 */
export function applyChroma(imageData, chroma) {
  if (!chroma?.enabled) return imageData;
  const key = hexToRgb(chroma.color);
  const similarity = Math.max(0, Math.min(1, chroma.similarity ?? 0.3));
  const blend = Math.max(0, Math.min(1, chroma.blend ?? 0.1));
  const doDespill = chroma.despill !== false;
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const alpha = keyAlpha(r, g, b, key, similarity, blend);
    if (doDespill) {
      // comme ffmpeg : le despill corrige la couleur même sous un alpha partiel
      const fixed = despill(r, g, b, key);
      data[i] = fixed.r;
      data[i + 1] = fixed.g;
      data[i + 2] = fixed.b;
    }
    if (alpha >= 1) continue;
    data[i + 3] = Math.round(alpha * 255);
    if (alpha <= 0) data[i] = data[i + 1] = data[i + 2] = 0;
  }
  return imageData;
}

/** Taille d'un canvas de travail : même rapport que le média, côté borné. */
export function canvasSize(width, height, max = 480) {
  const w = Math.max(1, Number(width) || 1);
  const h = Math.max(1, Number(height) || 1);
  if (w >= h) return { width: max, height: Math.max(1, Math.round((max * h) / w)) };
  return { width: Math.max(1, Math.round((max * w) / h)), height: max };
}

/**
 * Rect du média réellement affiché dans une boîte CSS `object-fit`
 * (sert à la pipette : elle doit retrouver le pixel sous le curseur).
 */
export function contentRect(naturalW, naturalH, boxW, boxH, fit = "cover") {
  const nw = Math.max(1, naturalW);
  const nh = Math.max(1, naturalH);
  const aspect = nw / nh;
  const boxAspect = boxW / boxH;
  const cover = fit !== "contain";
  const useWidth = cover ? aspect < boxAspect : aspect > boxAspect;
  const cw = useWidth ? boxW : boxH * aspect;
  const ch = useWidth ? boxW / aspect : boxH;
  return { left: (boxW - cw) / 2, top: (boxH - ch) / 2, width: cw, height: ch };
}
