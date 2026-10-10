/**
 * A sync session = (relay URL, shared secret). No accounts: holding the join
 * link IS the permission. Stored only on this device.
 */
import { generateSecret } from "./crypto";

export interface Session {
  relay: string;
  secret: string;
}

const KEY = "notes-hq:session";

export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export function saveSession(s: Session | null): void {
  if (s) localStorage.setItem(KEY, JSON.stringify(s));
  else localStorage.removeItem(KEY);
}

export function newSession(relay: string): Session {
  return { relay, secret: generateSecret() };
}

/** Relay the app should suggest by default: build-time setting, else the origin serving the app. */
export function defaultRelayUrl(): string {
  const configured = import.meta.env.VITE_RELAY_URL as string | undefined;
  if (configured) return configured;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}`;
}

/** Join link: <app>/#join?r=<relay>&k=<secret>. The fragment never leaves the browser. */
export function joinLink(s: Session): string {
  const params = new URLSearchParams({ r: s.relay, k: s.secret });
  return `${location.origin}${location.pathname}#join?${params}`;
}

/** If the current URL is a join link, returns the session and strips it from the address bar. */
export function consumeJoinLink(): Session | null {
  if (!location.hash.startsWith("#join?")) return null;
  const params = new URLSearchParams(location.hash.slice("#join?".length));
  history.replaceState(null, "", location.pathname + location.search);
  const relay = params.get("r");
  const secret = params.get("k");
  return relay && secret ? { relay, secret } : null;
}
