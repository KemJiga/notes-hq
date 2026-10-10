import { DEFAULT_MAX_DATA_BYTES } from "@notes-hq/protocol";

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  /** Optional directory of built web app files to serve from the same origin. */
  staticDir: string | null;
  /** Allowed browser origins for WebSocket connections. Empty = allow any. */
  allowedOrigins: string[];
  maxDataBytes: number;
  maxSubsPerPeer: number;
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer, got "${v}"`);
  return n;
}

export function loadConfig(): Config {
  return {
    host: process.env.HOST || "0.0.0.0",
    port: int("PORT", 8787),
    dataDir: process.env.DATA_DIR || "./data",
    staticDir: process.env.STATIC_DIR || null,
    allowedOrigins: (process.env.ALLOWED_ORIGINS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    maxDataBytes: int("MAX_DATA_BYTES", DEFAULT_MAX_DATA_BYTES),
    maxSubsPerPeer: int("MAX_SUBS_PER_PEER", 10_000),
  };
}
