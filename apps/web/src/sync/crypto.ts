/**
 * End-to-end encryption for sync. The relay only ever sees:
 *   - the room id (derived from the session key, not reversible)
 *   - opaque doc ids (HMAC of the internal doc name)
 *   - AES-GCM ciphertext
 * The session key itself travels only inside the join link's #fragment,
 * which browsers never send to any server.
 */
import { fromBase64Url, toBase64Url } from "@notes-hq/protocol";

const enc = new TextEncoder();

export interface SessionKeys {
  roomId: string;
  encKey: CryptoKey;
  macKey: CryptoKey;
}

export function generateSecret(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

async function hkdf(secret: Uint8Array<ArrayBuffer>, info: string, bits: number): Promise<Uint8Array<ArrayBuffer>> {
  const base = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveBits"]);
  const out = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode("notes-hq/v1"), info: enc.encode(info) },
    base,
    bits,
  );
  return new Uint8Array(out);
}

export async function deriveKeys(secretB64: string): Promise<SessionKeys> {
  const secret = fromBase64Url(secretB64);
  if (secret.length !== 32) throw new Error("invalid session secret");
  const [roomBytes, encBytes, macBytes] = await Promise.all([
    hkdf(secret, "room-id", 128),
    hkdf(secret, "enc-key", 256),
    hkdf(secret, "mac-key", 256),
  ]);
  return {
    roomId: toBase64Url(roomBytes),
    encKey: await crypto.subtle.importKey("raw", encBytes, "AES-GCM", false, ["encrypt", "decrypt"]),
    macKey: await crypto.subtle.importKey("raw", macBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
  };
}

/** Maps an internal doc name (e.g. "index", "note:<uuid>") to the opaque id the relay sees. */
export async function opaqueDocId(keys: SessionKeys, name: string): Promise<string> {
  const mac = await crypto.subtle.sign("HMAC", keys.macKey, enc.encode(name));
  return toBase64Url(new Uint8Array(mac).slice(0, 16));
}

export async function seal(keys: SessionKeys, docId: string, plain: Uint8Array): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: enc.encode(`${keys.roomId}/${docId}`) },
    keys.encKey,
    plain as Uint8Array<ArrayBuffer>,
  );
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv);
  out.set(new Uint8Array(ct), 12);
  return toBase64Url(out);
}

/** Returns null if the payload was not produced with this session's key (garbage from a stranger, corruption). */
export async function open(keys: SessionKeys, docId: string, data: string): Promise<Uint8Array | null> {
  try {
    const bytes = fromBase64Url(data);
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: enc.encode(`${keys.roomId}/${docId}`) },
      keys.encKey,
      bytes.slice(12),
    );
    return new Uint8Array(pt);
  } catch {
    return null;
  }
}
