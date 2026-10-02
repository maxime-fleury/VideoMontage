import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR, ensureDir, formatBytes } from "./util";

/** Dossier de travail du rendu : c'est ici (cwd) que ffmpeg tourne et lit `subtitles.ass`. */
export const FONTS_DIR = `${DATA_DIR}/fonts`;
/** Les TTF sont isolés dans un sous-dossier: libass ne tente plus de parser le .ass comme une police. */
export const FONT_TTF_DIR = `${FONTS_DIR}/ttf`;

const CSS_API = "https://fonts.googleapis.com/css2";
/**
 * User-agent « ancien »: l'API Google Fonts renvoie alors un TTF par graisse.
 * Indispensable ici: libass (fournisseur directwrite sous Windows) ignore les
 * polices variables (`Outfit[wght].ttf`) et retombe silencieusement sur Arial.
 */
const LEGACY_UA =
  "Mozilla/5.0 (Windows NT 5.1) AppleWebKit/534.30 (KHTML, like Gecko) Version/5.0 Safari/534.30";

/** `label` doit rester le nom exact de la famille: il finit dans le fichier .ass. */
export type FontFile = { weight: number; name: string };
export type FontDef = { id: string; label: string; note?: string; query: string; files: FontFile[] };

const regular = (name: string): FontFile => ({ weight: 400, name });
const bold = (name: string): FontFile => ({ weight: 700, name });

/** Familles disponibles (TTF statiques: compatibles libass et navigateur). */
export const FONTS: FontDef[] = [
  {
    id: "Outfit",
    label: "Outfit",
    query: "Outfit:wght@400;700",
    files: [regular("Outfit-Regular.ttf"), bold("Outfit-Bold.ttf")],
  },
  {
    id: "Inter",
    label: "Inter",
    query: "Inter:wght@400;700",
    files: [regular("Inter-Regular.ttf"), bold("Inter-Bold.ttf")],
  },
  {
    id: "Poppins",
    label: "Poppins",
    query: "Poppins:wght@400;700",
    files: [regular("Poppins-Regular.ttf"), bold("Poppins-Bold.ttf")],
  },
  {
    id: "Montserrat",
    label: "Montserrat",
    query: "Montserrat:wght@400;700",
    files: [regular("Montserrat-Regular.ttf"), bold("Montserrat-Bold.ttf")],
  },
  {
    id: "Space Grotesk",
    label: "Space Grotesk",
    query: "Space+Grotesk:wght@400;700",
    files: [regular("SpaceGrotesk-Regular.ttf"), bold("SpaceGrotesk-Bold.ttf")],
  },
  {
    id: "Sora",
    label: "Sora",
    query: "Sora:wght@400;700",
    files: [regular("Sora-Regular.ttf"), bold("Sora-Bold.ttf")],
  },
  {
    id: "Oswald",
    label: "Oswald",
    query: "Oswald:wght@400;700",
    files: [regular("Oswald-Regular.ttf"), bold("Oswald-Bold.ttf")],
  },
  {
    id: "Bebas Neue",
    label: "Bebas Neue",
    note: "titres",
    query: "Bebas+Neue",
    files: [regular("BebasNeue-Regular.ttf")],
  },
  {
    id: "Anton",
    label: "Anton",
    note: "impact",
    query: "Anton",
    files: [regular("Anton-Regular.ttf")],
  },
  {
    id: "Playfair Display",
    label: "Playfair Display",
    note: "élégant",
    query: "Playfair+Display:wght@400;700",
    files: [regular("PlayfairDisplay-Regular.ttf"), bold("PlayfairDisplay-Bold.ttf")],
  },
  {
    id: "Rubik",
    label: "Rubik",
    query: "Rubik:wght@400;700",
    files: [regular("Rubik-Regular.ttf"), bold("Rubik-Bold.ttf")],
  },
];

/**
 * Anciens fichiers à retirer une fois les TTF en place: polices variables (ignorées par
 * libass → repli Arial) et anciens doublons laissés à la racine du dossier.
 */
const LEGACY_FILES = [
  "Outfit.ttf",
  "Inter.ttf",
  "Montserrat.ttf",
  "SpaceGrotesk.ttf",
  "Oswald.ttf",
  "PlayfairDisplay.ttf",
  "Rubik.ttf",
  "Poppins-Regular.ttf",
  "Poppins-Bold.ttf",
  "BebasNeue-Regular.ttf",
  "Anton-Regular.ttf",
];
/** Noms autorisés aussi dans `ttf/` (ils y sont installés par cette version). */
const CURRENT_NAMES = new Set(FONTS.flatMap((f) => f.files.map((file) => file.name)));

function fontBy(id: string) {
  return FONTS.find((f) => f.id === id || f.label === id || f.label.startsWith(id));
}

export async function listFonts() {
  await ensureDir(FONT_TTF_DIR);
  const installedFiles = new Set(await fs.readdir(FONT_TTF_DIR).catch(() => []));
  return FONTS.map((font) => ({
    id: font.id,
    label: font.label,
    note: font.note || "",
    installed: font.files.every((file) => installedFiles.has(file.name)),
    files: font.files.map((file) => ({ name: file.name, weight: file.weight })),
  }));
}

/** Récupère le CSS Google Fonts et associe chaque graisse à son URL de TTF. */
async function resolveTtfUrls(font: FontDef) {
  const res = await fetch(`${CSS_API}?family=${font.query}&display=swap`, {
    headers: { "user-agent": LEGACY_UA },
  });
  if (!res.ok) throw new Error(`Google Fonts a refusé la requête (${res.status}) : ${font.label}`);
  const css = await res.text();
  const urls = new Map<number, string>();
  for (const block of css.split("@font-face").slice(1)) {
    const weight = /font-weight:\s*(\d+)/.exec(block);
    const url = /url\((https?:\/\/[^)]+\.ttf)\)/.exec(block);
    if (weight && url) urls.set(Number(weight[1]), url[1]);
  }
  if (!urls.size) throw new Error(`Aucune police TTF trouvée pour ${font.label}`);
  return urls;
}

async function download(url: string, dest: string) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`Téléchargement impossible (${res.status})`);
  const writer = Bun.file(dest).writer();
  const reader = res.body.getReader();
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    writer.write(value);
    received += value.length;
  }
  await writer.end();
  // Un TTF valide fait plusieurs dizaines de Ko; en dessous, c'est une page d'erreur.
  if (received < 4000) {
    await fs.rm(dest, { force: true });
    throw new Error(`Fichier de police invalide (${formatBytes(received)})`);
  }
  return received;
}

/**
 * Retire les anciens fichiers de la racine de `data/fonts` (les TTF actifs vivent dans
 * `ttf/`). Les noms utilisés par la version actuelle ne sont jamais supprimés de `ttf/`.
 */
async function cleanupLegacy() {
  for (const name of LEGACY_FILES) {
    await fs.rm(path.join(FONTS_DIR, name), { force: true }).catch(() => {});
    if (!CURRENT_NAMES.has(name)) {
      await fs.rm(path.join(FONT_TTF_DIR, name), { force: true }).catch(() => {});
    }
  }
}

export async function installFont(id: string, onProgress?: (p: number, message?: string) => void) {
  const font = fontBy(id);
  if (!font) throw new Error(`Police inconnue : ${id}`);
  await ensureDir(FONT_TTF_DIR);
  const todo: FontFile[] = [];
  for (const file of font.files) {
    const dest = path.join(FONT_TTF_DIR, file.name);
    if (await Bun.file(dest).exists()) continue;
    todo.push(file);
  }
  if (todo.length) {
    const urls = await resolveTtfUrls(font);
    let index = 0;
    for (const file of todo) {
      index++;
      const url = urls.get(file.weight) || [...urls.values()][0];
      onProgress?.((index - 1) / todo.length, `Téléchargement de ${font.label} (${file.weight})…`);
      await download(url, path.join(FONT_TTF_DIR, file.name));
    }
  }
  await cleanupLegacy();
  onProgress?.(1, `${font.label} installée`);
}

/** Installe toutes les familles au premier lancement (les fichiers déjà présents sont ignorés). */
export async function installRecommendedFonts(onProgress?: (p: number, message?: string) => void) {
  let index = 0;
  for (const font of FONTS) {
    index++;
    try {
      await installFont(font.id, (p, message) =>
        onProgress?.((index - 1 + p) / FONTS.length, message || `Police ${font.label}…`)
      );
    } catch {
      // une police qui échoue ne doit pas bloquer
    }
  }
  onProgress?.(1, "Polices prêtes");
}
