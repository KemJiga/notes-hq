/**
 * notes-hq sync protocol, version 1.
 *
 * Transport: one WebSocket per device per room, at `<relay>/v1/rooms/<roomId>`.
 * Frames are JSON text. Payloads (`data`) are base64url-encoded ciphertext that
 * the relay never decrypts. See docs/PROTOCOL.md for the full description.
 */

export const PROTOCOL_VERSION = 1;

/** Room ids and doc ids are opaque base64url strings derived on the client. */
export const ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

/** Default maximum size of one encoded `data` field (bytes of base64url text). */
export const DEFAULT_MAX_DATA_BYTES = 1024 * 1024;

// ---------- client -> relay ----------

/** Subscribe to a doc. The relay replies with backlog, then `synced`. */
export interface SubMsg {
  t: "sub";
  doc: string;
  /** Highest seq the client has already applied for this doc (0 = nothing). */
  since: number;
}

export interface UnsubMsg {
  t: "unsub";
  doc: string;
}

/** Append one encrypted update to a doc's log. */
export interface PushMsg {
  t: "push";
  doc: string;
  /** Client-chosen reference echoed back in the `ack`. */
  ref: string;
  data: string;
}

/**
 * Replace every log entry with seq <= upTo by one encrypted snapshot.
 * The client must have applied all entries up to `upTo` before sending this.
 */
export interface CompactMsg {
  t: "compact";
  doc: string;
  upTo: number;
  data: string;
}

export type ClientMsg = SubMsg | UnsubMsg | PushMsg | CompactMsg;

// ---------- relay -> client ----------

/** Snapshot covering every update up to and including `seq`. */
export interface SnapMsg {
  t: "snap";
  doc: string;
  seq: number;
  data: string;
}

export interface UpdMsg {
  t: "upd";
  doc: string;
  seq: number;
  data: string;
}

/** Backlog for `doc` has been fully sent; live updates follow. */
export interface SyncedMsg {
  t: "synced";
  doc: string;
  seq: number;
}

export interface AckMsg {
  t: "ack";
  doc: string;
  ref: string;
  seq: number;
}

export type ErrorCode = "bad_message" | "too_large" | "bad_compact" | "unavailable";

export interface ErrMsg {
  t: "err";
  code: ErrorCode;
  msg: string;
}

export type ServerMsg = SnapMsg | UpdMsg | SyncedMsg | AckMsg | ErrMsg;

// ---------- validation ----------

function isId(v: unknown): v is string {
  return typeof v === "string" && ID_PATTERN.test(v);
}

function isSeq(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

function isData(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && /^[A-Za-z0-9_-]+$/.test(v);
}

/** Parses and validates a client frame. Returns null if it is malformed. */
export function parseClientMsg(raw: string): ClientMsg | null {
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof m !== "object" || m === null) return null;
  const o = m as Record<string, unknown>;
  switch (o.t) {
    case "sub":
      return isId(o.doc) && isSeq(o.since) ? { t: "sub", doc: o.doc, since: o.since } : null;
    case "unsub":
      return isId(o.doc) ? { t: "unsub", doc: o.doc } : null;
    case "push":
      return isId(o.doc) && typeof o.ref === "string" && o.ref.length <= 64 && isData(o.data)
        ? { t: "push", doc: o.doc, ref: o.ref, data: o.data }
        : null;
    case "compact":
      return isId(o.doc) && isSeq(o.upTo) && isData(o.data)
        ? { t: "compact", doc: o.doc, upTo: o.upTo, data: o.data }
        : null;
    default:
      return null;
  }
}

/** Parses a relay frame on the client. Trusts shape loosely; the relay is not trusted with content anyway. */
export function parseServerMsg(raw: string): ServerMsg | null {
  try {
    const m = JSON.parse(raw) as ServerMsg;
    return typeof m === "object" && m !== null && typeof m.t === "string" ? m : null;
  } catch {
    return null;
  }
}

// ---------- base64url ----------

export function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
