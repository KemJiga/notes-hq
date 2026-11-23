/**
 * Link previews: the per-device setting, the relay's optional unfurl endpoint
 * (DESIGN.md D15) and the click-to-load video embeds. No Tiptap in here, so it
 * stays testable and out of the editor chunk's way.
 */
import type { UnfurlPreview } from "@notes-hq/protocol";
import { defaultRelayUrl, loadSession } from "./sync/session";

/** What a link card stores in the note. `image` is a small JPEG data URL, so cards render offline. */
export interface CardData {
  url: string;
  title: string;
  description: string | null;
  siteName: string | null;
  image: string | null;
}

const KEY = "notes-hq:link-previews";

/** On unless turned off on this device. Nothing is fetched until the user asks for a preview. */
export function previewsEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) !== "0";
  } catch {
    return true;
  }
}

export function setPreviewsEnabled(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    /* storage blocked: the switch just won't stick */
  }
}

/** A bare http(s) link to a dotted host: what's worth offering a preview for. */
export function isHttpUrl(s: string): boolean {
  if (!/^https?:\/\/\S+$/i.test(s)) return false;
  try {
    return new URL(s).hostname.includes(".");
  } catch {
    return false;
  }
}

/** `wss://relay.example/` → `https://relay.example/v1/unfurl?url=…` (same prefix rule as the sync socket). */
export function unfurlEndpoint(relay: string, link: string): string {
  return `${relay.replace(/^ws/i, "http").replace(/\/+$/, "")}/v1/unfurl?url=${encodeURIComponent(link)}`;
}

/** YouTube/Vimeo player for a click-to-load embed, or null for anything else. */
export function embedUrl(link: string): string | null {
  let u: URL;
  try {
    u = new URL(link);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^(www|m)\./, "");
  const yt =
    host === "youtu.be" ? u.pathname.slice(1) : host === "youtube.com" ? (u.pathname === "/watch" ? u.searchParams.get("v") : /^\/(?:shorts|live|embed)\/([^/]+)/.exec(u.pathname)?.[1]) : null;
  if (yt && /^[\w-]{11}$/.test(yt)) return `https://www.youtube-nocookie.com/embed/${yt}?autoplay=1`;
  const vimeo = host === "vimeo.com" ? /^\/(\d+)(?:\/|$)/.exec(u.pathname)?.[1] : null;
  return vimeo ? `https://player.vimeo.com/video/${vimeo}?autoplay=1&dnt=1` : null;
}

/** Crops to a centred 160px square JPEG: the card shows 80px, and it must stay small inside the synced note. */
async function thumbnail(src: string): Promise<string | null> {
  try {
    const img = new Image();
    img.src = src;
    await img.decode();
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const out = Math.min(side, 160);
    const c = document.createElement("canvas");
    c.width = c.height = out;
    const g = c.getContext("2d")!;
    g.fillStyle = "#fff"; // JPEG has no alpha
    g.fillRect(0, 0, out, out);
    g.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, out, out);
    return c.toDataURL("image/jpeg", 0.8);
  } catch {
    return null;
  }
}

const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

/** Asks the relay for a preview. Null when previews are off on the relay, it's unreachable, or the page has no title. */
export async function fetchPreview(link: string): Promise<CardData | null> {
  try {
    const res = await fetch(unfurlEndpoint(loadSession()?.relay ?? defaultRelayUrl(), link), { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const p = (await res.json()) as Partial<UnfurlPreview>;
    const title = text(p.title, 300);
    if (!title) return null;
    const image = typeof p.image === "string" && p.image.startsWith("data:image/") ? await thumbnail(p.image) : null;
    return { url: link, title, description: text(p.description, 500), siteName: text(p.siteName, 100), image };
  } catch {
    return null;
  }
}
