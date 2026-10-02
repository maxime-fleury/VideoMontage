import fs from "node:fs/promises";
import crypto from "node:crypto";
import { DATA_DIR, ensureDir, mediaDir, newId, projectDir, slug } from "./util";
import type { Project, Source } from "./store";
import { probe } from "./ffmpeg";

export type ImageResult = {
  id: string;
  provider: string;
  thumb: string;
  url: string;
  title: string;
  width?: number;
  height?: number;
  pageUrl?: string;
  author?: string;
  license?: string;
};

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

async function fetchWithUA(url: string, extraHeaders: Record<string, string> = {}) {
  return fetch(url, {
    headers: {
      "user-agent": UA,
      accept: "*/*",
      "accept-language": "fr-FR,fr;q=0.9,en;q=0.8",
      ...extraHeaders,
    },
  });
}

function decodeHtml(input: string) {
  return input
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

/** Recherche d'images web via scraping de Bing Images (résultats variés du web). */
async function searchBing(query: string, count: number): Promise<ImageResult[]> {
  const url = `https://www.bing.com/images/search?q=${encodeURIComponent(query)}&form=HDRSC2&first=1&count=${Math.max(35, count)}`;
  const res = await fetchWithUA(url);
  if (!res.ok) throw new Error(`Bing a répondu ${res.status}`);
  const html = await res.text();
  const chunks = [...html.matchAll(/m="(\{[^"]*?\})"/g)].map((m) => m[1]);
  const results: ImageResult[] = [];
  for (const chunk of chunks) {
    let item: any;
    try {
      item = JSON.parse(decodeHtml(chunk));
    } catch {
      continue;
    }
    if (!item?.murl) continue;
    results.push({
      id: `bing_${results.length}_${crypto.createHash("md5").update(String(item.murl)).digest("hex").slice(0, 8)}`,
      provider: "web",
      thumb: item.turl || item.murl,
      url: item.murl,
      title: decodeHtml(String(item.t || query)),
      pageUrl: item.purl,
      width: item.mw ? Number(item.mw) : undefined,
      height: item.mh ? Number(item.mh) : undefined,
    });
    if (results.length >= count) break;
  }
  if (!results.length) throw new Error("Aucun résultat exploitable chez Bing");
  return results;
}

/** Repli : recherche d'images via le endpoint public de DuckDuckGo (scraping du token vqd). */
async function searchDuckDuckGo(query: string, count: number): Promise<ImageResult[]> {
  const page = await fetchWithUA(`https://duckduckgo.com/?q=${encodeURIComponent(query)}&iax=images&ia=images`);
  if (!page.ok) throw new Error(`DuckDuckGo a répondu ${page.status}`);
  const html = await page.text();
  const vqdMatch = html.match(/vqd=["']?([\d-]+)/) || html.match(/vqd=([\d-]+)&/);
  if (!vqdMatch) throw new Error("Jeton vqd introuvable (DuckDuckGo a peut-être changé)");
  const vqd = vqdMatch[1];
  const apiUrl = `https://duckduckgo.com/i.js?l=fr-fr&o=json&q=${encodeURIComponent(query)}&vqd=${vqd}&f=,,,&p=1`;
  const res = await fetchWithUA(apiUrl, { referer: "https://duckduckgo.com/", accept: "application/json" });
  if (!res.ok) throw new Error(`Recherche images DuckDuckGo ${res.status}`);
  const data: any = await res.json();
  const results: any[] = data.results || [];
  return results.slice(0, count).map((r, i) => ({
    id: `ddg_${i}_${crypto.createHash("md5").update(String(r.image)).digest("hex").slice(0, 8)}`,
    provider: "web",
    thumb: r.thumbnail || r.image,
    url: r.image,
    title: r.title || query,
    width: r.width,
    height: r.height,
    pageUrl: r.url,
  }));
}

/** Fournisseur « web » : Bing puis DuckDuckGo en repli. */
async function searchWeb(query: string, count: number): Promise<ImageResult[]> {
  try {
    return await searchBing(query, count);
  } catch (bingError) {
    try {
      return await searchDuckDuckGo(query, count);
    } catch (ddgError) {
      throw new Error(`web : ${bingError instanceof Error ? bingError.message : bingError}`);
    }
  }
}

/** Openverse: images Creative Commons, API stable et sans clé. */
async function searchOpenverse(query: string, count: number): Promise<ImageResult[]> {
  const url = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&page_size=${count}&license_type=all`;
  const res = await fetchWithUA(url);
  if (!res.ok) throw new Error(`Openverse ${res.status}`);
  const data: any = await res.json();
  return (data.results || []).map((r: any) => ({
    id: `ov_${r.id}`,
    provider: "openverse",
    thumb: r.thumbnail || r.url,
    url: r.url,
    title: r.title || query,
    width: r.width,
    height: r.height,
    pageUrl: r.foreign_landing_url,
    author: r.creator,
    license: [r.license, r.license_version].filter(Boolean).join(" ").toUpperCase(),
  }));
}

/** Wikimedia Commons: illustrations libres, sans clé. */
async function searchWikimedia(query: string, count: number): Promise<ImageResult[]> {
  const url = `https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrnamespace=6&gsrlimit=${count}&gsrsearch=${encodeURIComponent(
    query
  )}&prop=imageinfo&iiprop=url|size|mime&iiurlwidth=400`;
  const res = await fetchWithUA(url);
  if (!res.ok) throw new Error(`Wikimedia ${res.status}`);
  const data: any = await res.json();
  const pages = Object.values(data?.query?.pages || {}) as any[];
  return pages
    .filter((p) => p.imageinfo?.[0]?.url)
    .map((p) => ({
      id: `wm_${p.pageid}`,
      provider: "wikimedia",
      thumb: p.imageinfo[0].thumburl || p.imageinfo[0].url,
      url: p.imageinfo[0].url,
      title: String(p.title || query).replace(/^File:/, ""),
      width: p.imageinfo[0].width,
      height: p.imageinfo[0].height,
      pageUrl: p.imageinfo[0].descriptionurl,
      license: "Wikimedia",
    }));
}

export async function searchImages(
  query: string,
  opts: { provider?: string; count?: number } = {}
): Promise<{ results: ImageResult[]; errors: string[] }> {
  const count = Math.min(40, Math.max(4, opts.count ?? 20));
  let provider = opts.provider || "web";
  const errors: string[] = [];
  const providers: Record<string, (q: string, c: number) => Promise<ImageResult[]>> = {
    web: searchWeb,
    openverse: searchOpenverse,
    wikimedia: searchWikimedia,
  };
  if (provider === "duckduckgo") provider = "web";
  const order = [provider, ...Object.keys(providers).filter((p) => p !== provider)];
  for (const p of order) {
    try {
      const results = await providers[p](query, count);
      const usable = results.filter((r) => r.url && /^https?:/.test(r.url));
      if (usable.length) return { results: usable, errors };
    } catch (e) {
      errors.push(`${p} : ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { results: [], errors };
}

function guessMimeFromUrl(url: string) {
  const ext = (url.split("?")[0].match(/\.([a-z0-9]+)$/i)?.[1] || "").toLowerCase();
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  if (ext === "avif") return "image/avif";
  if (ext === "bmp") return "image/bmp";
  return "";
}

const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "image/bmp": "bmp",
};

/** Détecte le format à partir des octets d'en-tête (plus sûr que le content-type annoncé). */
function sniffMime(buf: Uint8Array): string {
  if (buf.length < 12) return "";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "image/gif";
  if (buf[0] === 0x42 && buf[1] === 0x4d) return "image/bmp";
  const brand = String.fromCharCode(...buf.slice(4, 12));
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46) return brand.startsWith("WEBP") ? "image/webp" : "";
  if (brand.startsWith("ftyp")) return /avif|avis/.test(brand) ? "image/avif" : "";
  return "";
}

function imageCachePath(url: string) {
  return `${DATA_DIR}/cache/img/${crypto.createHash("sha1").update(url).digest("hex")}`;
}

export async function downloadImage(
  project: Project,
  input: { url: string; fallbackUrl?: string; referer?: string; keyword?: string; provider?: string }
): Promise<Source> {
  const seen = new Set<string>();
  const candidates: { url: string; referer?: string }[] = [];
  const push = (url?: string, referer?: string) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    candidates.push({ url, referer });
  };
  // L'URL de la vignette vue par l'utilisateur est souvent servie par un CDN qui
  // refuse le hotlink: on la garde en dernier recours (et elle est déjà en cache).
  push(input.url, input.referer);
  push(input.url);
  push(input.fallbackUrl, input.referer);
  push(input.fallbackUrl);

  let buf: Uint8Array | null = null;
  let mime = "";
  const failures: string[] = [];

  for (const candidate of candidates) {
    const cached = Bun.file(imageCachePath(candidate.url));
    if (await cached.exists()) {
      buf = new Uint8Array(await cached.arrayBuffer());
      mime = cached.type && MIME_EXT[cached.type] ? cached.type : "";
      break;
    }
  }

  if (!buf) {
    for (const candidate of candidates) {
      try {
        const res = await fetchWithUA(candidate.url, candidate.referer ? { referer: candidate.referer } : {});
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = new Uint8Array(await res.arrayBuffer());
        if (!data.length) throw new Error("fichier vide");
        buf = data;
        mime = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
        break;
      } catch (e) {
        failures.push(e instanceof Error ? e.message : String(e));
      }
    }
  }

  if (!buf) {
    const detail = [...new Set(failures)].slice(0, 2).join(" / ") || "source inaccessible";
    throw new Error(`Image non téléchargeable (${detail}) — essaie une autre proposition`);
  }
  if (buf.length > 40 * 1024 * 1024) throw new Error("Image trop lourde (> 40 Mo)");

  const guessed = sniffMime(buf) || (MIME_EXT[mime] ? mime : "") || guessMimeFromUrl(input.url);
  if (!MIME_EXT[guessed]) throw new Error(`Format non géré (${mime || "inconnu"})`);

  await ensureDir(mediaDir(project.id));
  const base = slug(input.keyword || "illustration");
  const file = `${newId("img")}-${base}.${MIME_EXT[guessed]}`;
  await Bun.write(`${mediaDir(project.id)}/${file}`, buf);

  let width: number | undefined;
  let height: number | undefined;
  try {
    const info = await probe(`${mediaDir(project.id)}/${file}`);
    width = info.width;
    height = info.height;
  } catch {}

  const source: Source = {
    id: newId("src"),
    kind: "image",
    name: input.keyword ? `${input.keyword}${width ? ` (${width}×${height})` : ""}` : file,
    file,
    duration: 0,
    width,
    height,
    origin: "search",
    meta: { url: input.url, provider: input.provider, keyword: input.keyword },
    createdAt: Date.now(),
  };
  return source;
}

/** Proxy d'images pour la grille de résultats (évite le hotlink/CORS). */
export async function proxyImage(url: string, referer?: string): Promise<Response> {
  const hash = crypto.createHash("sha1").update(url).digest("hex");
  const cacheDir = `${DATA_DIR}/cache/img`;
  const cachePath = `${cacheDir}/${hash}`;
  if (await Bun.file(cachePath).exists()) {
    const cached = Bun.file(cachePath);
    return new Response(cached, {
      headers: { "content-type": cached.type || "image/jpeg", "cache-control": "public, max-age=86400" },
    });
  }
  const res = await fetchWithUA(url, referer ? { referer } : {});
  if (!res.ok) return new Response("Image indisponible", { status: 502 });
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length > 12 * 1024 * 1024) return new Response("Image trop lourde", { status: 413 });
  await ensureDir(cacheDir);
  await Bun.write(cachePath, buf);
  const type = (res.headers.get("content-type") || "image/jpeg").split(";")[0];
  if (!type.startsWith("image/")) return new Response("Pas une image", { status: 415 });
  return new Response(buf, {
    headers: { "content-type": type, "cache-control": "public, max-age=86400" },
  });
}

export function thumbProxyUrl(url: string, referer?: string) {
  return `/api/imgproxy?url=${encodeURIComponent(url)}${referer ? `&referer=${encodeURIComponent(referer)}` : ""}`;
}
