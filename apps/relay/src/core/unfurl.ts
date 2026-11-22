/**
 * Optional link-preview ("unfurl") service. It only ever sees the URL it is
 * asked to preview, never note content, and it keeps nothing: no logs, no cache.
 *
 * Runtime-agnostic: each adapter passes a `Fetcher` that does ONE request and
 * does not follow redirects. Redirects, limits and parsing live here so both
 * runtimes behave the same. The Node fetcher also checks every resolved IP
 * (see src/server/fetcher.ts); `checkTarget` covers what can be checked from the URL.
 */
import type { UnfurlPreview } from "@notes-hq/protocol";

/** Does one HTTP GET without following redirects. */
export type Fetcher = (url: URL, signal: AbortSignal) => Promise<Response>;

export const UNFURL_MAX_BYTES = 1024 * 1024;
export const UNFURL_TIMEOUT_MS = 5000;
const MAX_REDIRECTS = 5;
const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp|avif)$/;

export class UnfurlError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// ---------- SSRF guard ----------

function v4(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return null;
  return parts.map(Number);
}

function publicV4([a, b]: number[]): boolean {
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a! >= 224 || // multicast, reserved, broadcast
    (a === 100 && b! >= 64 && b! <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) || // 192.0.0.0/24 protocol assignments (and 192.0.2.0/24 docs)
    (a === 198 && (b === 18 || b === 19)) // benchmarking
  );
}

/** Expands an IPv6 address to 8 groups, or null if it isn't one. */
function v6(ip: string): number[] | null {
  let s = ip.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) {
    const q = v4(tail[1]!);
    if (!q) return null;
    s = s.slice(0, -tail[1]!.length) + `${((q[0]! << 8) | q[1]!).toString(16)}:${((q[2]! << 8) | q[3]!).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  const groups = [...head, ...Array<string>(Math.max(fill, 0)).fill("0"), ...rest];
  if (groups.length !== 8 || (halves.length === 2 && fill < 1)) return null;
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

/** True only for globally routable unicast addresses. Anything unparseable is not public. */
export function isPublicIp(ip: string): boolean {
  const q = v4(ip);
  if (q) return publicV4(q);
  const g = v6(ip);
  if (!g) return false;
  const embedded = [g[6]! >> 8, g[6]! & 255, g[7]! >> 8, g[7]! & 255];
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return publicV4(embedded); // ::ffff:a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return publicV4(embedded); // NAT64
  if (g.slice(0, 7).every((x) => x === 0)) return false; // :: and ::1 (and deprecated ::a.b.c.d)
  if (g[0] === 0x2002) return publicV4([g[1]! >> 8, g[1]! & 255]); // 6to4 wraps an IPv4
  if ((g[0]! & 0xe000) !== 0x2000) return false; // only 2000::/3 is global unicast (drops fc00::/7, fe80::/10, ff00::/8)
  return !(g[0] === 0x2001 && (g[1]! < 0x200 || g[1] === 0xdb8)); // Teredo, benchmarking, ORCHID, documentation
}

/** Rejects anything that is not a plain http(s) URL to a public host on the default port. */
export function checkTarget(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new UnfurlError(400, "only http and https links");
  if (url.username || url.password) throw new UnfurlError(400, "credentials in link");
  if (url.port !== "") throw new UnfurlError(400, "non-default port");
  const host = url.hostname.toLowerCase().replace(/\.$/, ""); // "localhost." is still localhost
  if (v4(host) || host.startsWith("[")) {
    if (!isPublicIp(host)) throw new UnfurlError(400, "private address");
    return;
  }
  if (!host.includes(".") || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new UnfurlError(400, "private address");
  }
}

// ---------- fetching ----------

/** Reads at most `max` bytes. Past that, `truncate` keeps the first `max` bytes; otherwise it throws. */
async function readCapped(res: Response, max: number, truncate: boolean): Promise<Uint8Array> {
  if (!truncate && Number(res.headers.get("content-length")) > max) {
    await res.body?.cancel();
    throw new UnfurlError(502, "too large");
  }
  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = reader ? await reader.read() : { done: true, value: undefined };
    if (done) break;
    if (total + value.byteLength > max) {
      await reader!.cancel();
      if (!truncate) throw new UnfurlError(502, "too large");
      chunks.push(value.subarray(0, max - total));
      total = max;
      break;
    }
    total += value.byteLength;
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) out.set(c, (at += c.byteLength) - c.byteLength);
  return out;
}

/** GET with manual redirects; every hop is re-checked. Pages are cut at the cap (metadata sits in <head>). */
async function get(start: URL, fetcher: Fetcher, signal: AbortSignal, truncate = false): Promise<{ url: URL; type: string; body: Uint8Array }> {
  let url = start;
  for (let hop = 0; ; hop++) {
    checkTarget(url);
    const res = await fetcher(url, signal);
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel();
      if (hop >= MAX_REDIRECTS) throw new UnfurlError(502, "too many redirects");
      url = new URL(location, url);
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new UnfurlError(502, `upstream ${res.status}`);
    }
    return { url, type: res.headers.get("content-type") ?? "", body: await readCapped(res, UNFURL_MAX_BYTES, truncate) };
  }
}

// ---------- parsing ----------

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decode(s: string): string {
  return s
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] !== "#") return Object.hasOwn(ENTITIES, e.toLowerCase()) ? ENTITIES[e.toLowerCase()]! : m;
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    })
    .replace(/\s+/g, " ")
    .trim();
}

const MAX_TAG = 8192;

/**
 * Every `<name …>` tag, found with indexOf. Hostile pages can't make this
 * quadratic: each character is scanned once, and oversized tags are skipped.
 */
function tagsNamed(html: string, lower: string, name: string): string[] {
  const out: string[] = [];
  const open = "<" + name;
  for (let i = lower.indexOf(open); i >= 0; ) {
    const end = html.indexOf(">", i);
    if (end < 0) break; // no ">" here means none later either
    if (/[\s/>]/.test(lower[i + open.length] ?? "") && end - i <= MAX_TAG) out.push(html.slice(i, end + 1));
    i = lower.indexOf(open, end + 1); // anything before ">" belonged to this tag
  }
  return out;
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  // The lookbehind only starts a name where a name run begins, so a long run is tried once, not once per character.
  for (const m of tag.matchAll(/(?<![a-z0-9:_-])([a-z][a-z0-9:_-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)) {
    out[m[1]!.toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  return out;
}

function clip(s: string | undefined, n: number): string | undefined {
  return s ? (s.length > n ? s.slice(0, n - 1) + "…" : s) : undefined;
}

export interface PageMeta {
  title?: string;
  description?: string;
  siteName?: string;
  /** Absolute image URL, not yet fetched. */
  image?: string;
  /** Absolute oEmbed JSON URL, if the page advertises one. */
  oembed?: string;
}

/** Reads Open Graph, Twitter card and plain HTML metadata, plus oEmbed discovery. */
export function parseMeta(page: string, base: URL): PageMeta {
  // ASCII-only lowercasing keeps indexes aligned with the original string.
  let lower = page.replace(/[A-Z]+/g, (c) => c.toLowerCase());
  const headEnd = lower.indexOf("</head");
  const html = headEnd >= 0 ? page.slice(0, headEnd) : page;
  if (headEnd >= 0) lower = lower.slice(0, headEnd);
  const meta: Record<string, string> = {};
  for (const tag of tagsNamed(html, lower, "meta")) {
    const a = attrs(tag);
    const key = (a.property ?? a.name)?.toLowerCase();
    if (key && a.content !== undefined && !(key in meta)) meta[key] = decode(a.content);
  }
  let oembed: string | undefined;
  for (const tag of tagsNamed(html, lower, "link")) {
    const a = attrs(tag);
    if (a.type?.toLowerCase() === "application/json+oembed" && a.href) oembed ??= decode(a.href);
  }
  const t = lower.indexOf("<title");
  const gt = t >= 0 ? html.indexOf(">", t) : -1;
  const close = gt >= 0 ? lower.indexOf("</title", gt) : -1;
  const titleTag = close >= 0 ? html.slice(gt + 1, close) : undefined;
  const pick = (...keys: string[]) => keys.map((k) => meta[k]).find((v) => v);
  return {
    title: clip(pick("og:title", "twitter:title") ?? (titleTag ? decode(titleTag) : undefined), 300),
    description: clip(pick("og:description", "twitter:description", "description"), 500),
    siteName: clip(pick("og:site_name", "application-name"), 100),
    image: absHttp(pick("og:image:secure_url", "og:image", "og:image:url", "twitter:image", "twitter:image:src"), base),
    oembed: absHttp(oembed, base),
  };
}

function absHttp(u: string | undefined, base: URL): string | undefined {
  if (!u) return undefined;
  try {
    const r = new URL(u, base);
    return r.protocol === "http:" || r.protocol === "https:" ? r.href : undefined;
  } catch {
    return undefined;
  }
}

/** From Content-Type, else a `<meta charset>` near the top, else UTF-8. */
function charset(type: string, body: Uint8Array): string {
  const top = new TextDecoder("latin1").decode(body.subarray(0, 2048));
  return /charset=["']?([\w-]+)/i.exec(type)?.[1] ?? /<meta[^>]{0,200}?charset=["']?([\w-]+)/i.exec(top)?.[1] ?? "utf-8";
}

function text(body: Uint8Array, type: string): string {
  try {
    return new TextDecoder(charset(type, body)).decode(body);
  } catch {
    return new TextDecoder().decode(body); // unknown charset label
  }
}

function dataUrl(type: string, body: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < body.length; i += 0x8000) bin += String.fromCharCode(...body.subarray(i, i + 0x8000));
  return `data:${type};base64,${btoa(bin)}`;
}

/** Fetches `target` and returns its preview. The image comes back inline, so the app never hotlinks it. */
export async function unfurl(target: string, fetcher: Fetcher, timeoutMs = UNFURL_TIMEOUT_MS, cancel?: AbortSignal): Promise<UnfurlPreview> {
  let start: URL;
  try {
    start = new URL(target);
  } catch {
    throw new UnfurlError(400, "invalid link");
  }
  checkTarget(start);
  const signal = cancel ? AbortSignal.any([AbortSignal.timeout(timeoutMs), cancel]) : AbortSignal.timeout(timeoutMs);
  const page = await get(start, fetcher, signal, true);
  if (!/^(text\/html|application\/xhtml\+xml)\b/i.test(page.type)) throw new UnfurlError(502, "not a web page");
  const meta = parseMeta(text(page.body, page.type), page.url);

  if (meta.oembed && (!meta.title || !meta.image)) {
    try {
      const o = JSON.parse(text((await get(new URL(meta.oembed), fetcher, signal)).body, "")) as Record<string, unknown>;
      const str = (v: unknown) => (typeof v === "string" && v ? decode(v) : undefined);
      meta.title ??= clip(str(o.title), 300);
      meta.siteName ??= clip(str(o.provider_name), 100);
      meta.image ??= absHttp(str(o.thumbnail_url), page.url);
    } catch {
      /* oEmbed is a bonus; the page metadata is enough */
    }
  }

  let image: string | undefined;
  if (meta.image) {
    try {
      const img = await get(new URL(meta.image), fetcher, signal);
      const type = img.type.split(";")[0]!.trim().toLowerCase();
      if (IMAGE_TYPES.test(type)) image = dataUrl(type, img.body);
    } catch {
      /* a card without a thumbnail is still a card */
    }
  }

  const preview: UnfurlPreview = { url: page.url.href };
  if (meta.title) preview.title = meta.title;
  if (meta.description) preview.description = meta.description;
  if (meta.siteName) preview.siteName = meta.siteName;
  if (image) preview.image = image;
  return preview;
}

/**
 * `GET /v1/unfurl?url=<link>`. CORS follows the relay's origin allow-list.
 * Never logs: the link is the one thing this endpoint must not keep.
 */
export async function handleUnfurl(reqUrl: URL, origin: string | null, allowedOrigins: string[], fetcher: Fetcher, cancel?: AbortSignal): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json", "cache-control": "no-store" };
  if (origin) {
    if (allowedOrigins.length > 0 && !allowedOrigins.includes(origin)) return new Response('{"error":"forbidden origin"}', { status: 403, headers });
    headers["access-control-allow-origin"] = allowedOrigins.length > 0 ? origin : "*";
    if (allowedOrigins.length > 0) headers.vary = "origin";
  }
  try {
    const preview = await unfurl(reqUrl.searchParams.get("url") ?? "", fetcher, UNFURL_TIMEOUT_MS, cancel);
    return new Response(JSON.stringify(preview), { headers });
  } catch (err) {
    const status = err instanceof UnfurlError ? err.status : 502;
    const error = err instanceof UnfurlError ? err.message : "fetch failed";
    return new Response(JSON.stringify({ error }), { status, headers });
  }
}
