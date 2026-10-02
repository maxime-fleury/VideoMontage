import { FFMPEG, mediaDir, newId, run, slug } from "./util";
import type { Project, Source } from "./store";
import { probe } from "./ffmpeg";
import { sourcePath } from "./store";

export type ImageOps = {
  /** 1 = cadrage d'origine, >1 = zoom (recadrage centré) */
  zoom?: number;
  /** point visé, 0..1 (0.5 = centre) */
  focusX?: number;
  focusY?: number;
  rotate?: number; // degrés
  flipH?: boolean;
  flipV?: boolean;
  brightness?: number; // -1..1
  contrast?: number; // 0..2
  saturation?: number; // 0..3
  gamma?: number; // 0.1..10
  blur?: number; // sigma px
  grayscale?: boolean;
  sepia?: boolean;
  vignette?: boolean;
  /** détourage d'un fond de couleur (approximatif) */
  removeBackground?: boolean;
  bgColor?: string; // #rrggbb
  bgSimilarity?: number; // 0.01..0.5
  bgBlend?: number; // 0..1
};

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

export function buildImageFilters(ops: ImageOps, size: { width: number; height: number }) {
  const filters: string[] = [];
  const zoom = clamp(Number(ops.zoom ?? 1) || 1, 1, 4);
  const focusX = clamp(Number(ops.focusX ?? 0.5), 0, 1);
  const focusY = clamp(Number(ops.focusY ?? 0.5), 0, 1);
  if (zoom > 1.001) {
    const w = Math.round(size.width / zoom);
    const h = Math.round(size.height / zoom);
    const x = clamp(Math.round(focusX * size.width - w / 2), 0, Math.max(0, size.width - w));
    const y = clamp(Math.round(focusY * size.height - h / 2), 0, Math.max(0, size.height - h));
    filters.push(`crop=${w}:${h}:${x}:${y}`);
  }
  if (ops.flipH) filters.push("hflip");
  if (ops.flipV) filters.push("vflip");
  const rotate = Number(ops.rotate || 0);
  if (rotate % 360 !== 0) {
    const radians = (rotate * Math.PI) / 180;
    filters.push(`rotate=${radians.toFixed(5)}:ow=rotw(${radians.toFixed(5)}):oh=roth(${radians.toFixed(5)}):c=black@0`);
  }
  const brightness = clamp(Number(ops.brightness ?? 0) || 0, -1, 1);
  const contrast = clamp(Number(ops.contrast ?? 1) || 1, 0, 2);
  const saturation = clamp(Number(ops.saturation ?? 1) || 1, 0, 3);
  const gamma = clamp(Number(ops.gamma ?? 1) || 1, 0.1, 10);
  if (brightness !== 0 || contrast !== 1 || saturation !== 1 || gamma !== 1) {
    filters.push(
      `eq=brightness=${brightness.toFixed(3)}:contrast=${contrast.toFixed(3)}:saturation=${saturation.toFixed(3)}:gamma=${gamma.toFixed(3)}`
    );
  }
  if (ops.grayscale) filters.push("hue=s=0");
  if (ops.sepia) filters.push("colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131");
  if (ops.blur && Number(ops.blur) > 0.1) filters.push(`gblur=sigma=${clamp(Number(ops.blur), 0.1, 30).toFixed(2)}`);
  if (ops.vignette) filters.push("vignette=PI/5");
  if (ops.removeBackground) {
    const color = `0x${(ops.bgColor || "#ffffff").replace("#", "").toUpperCase()}`;
    const similarity = clamp(Number(ops.bgSimilarity ?? 0.12), 0.01, 0.6);
    const blend = clamp(Number(ops.bgBlend ?? 0.05), 0, 1);
    filters.push(`colorkey=${color}:${similarity.toFixed(3)}:${blend.toFixed(3)}`);
    filters.push("format=rgba");
  }
  return filters;
}

/** Applique des retouches et renvoie une nouvelle source PNG. */
export async function editImage(
  project: Project,
  source: Source,
  ops: ImageOps,
  keyword: string
): Promise<Source> {
  const input = sourcePath(project.id, source);
  const info = await probe(input);
  const size = { width: info.width || 1280, height: info.height || 720 };
  const filters = buildImageFilters(ops, size);
  const file = `${newId("img")}-${slug(keyword || "retouche")}.png`;
  const output = `${mediaDir(project.id)}/${file}`;
  const res = await run([
    FFMPEG,
    "-hide_banner",
    "-nostdin",
    "-y",
    "-i",
    input,
    "-vf",
    filters.length ? filters.join(",") : "null",
    "-frames:v",
    "1",
    output,
  ]);
  if (res.code !== 0) throw new Error(`Retouche impossible : ${res.stderr.slice(-400)}`);
  return {
    id: newId("src"),
    kind: "image",
    name: keyword ? `${keyword} (retouchée)` : `${source.name} (retouchée)`,
    file,
    duration: 0,
    width: size.width,
    height: size.height,
    origin: "search",
    meta: { keyword, editedFrom: source.id, ops },
    createdAt: Date.now(),
  };
}
