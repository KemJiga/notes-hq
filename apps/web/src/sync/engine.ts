/**
 * Local-first sync engine.
 *
 * - Every doc lives in memory as a Y.Doc and on disk in IndexedDB. The UI only
 *   ever talks to the Y.Doc, so it never waits on the network.
 * - When a session is set, one WebSocket to the relay carries all docs.
 *   Local edits are queued as `pending`, encrypted, pushed, and dropped on `ack`.
 * - Remote updates are decrypted and applied in arrival order.
 */
import * as Y from "yjs";
import { parseServerMsg, type ClientMsg, type ServerMsg } from "@notes-hq/protocol";
import { localStore } from "../storage/local";
import { deriveKeys, open, opaqueDocId, seal, type SessionKeys } from "./crypto";
import type { Session } from "./session";

export type SyncStatus = "local-only" | "connecting" | "online" | "offline";

const REMOTE = Symbol("remote");
const SAVE_DELAY_MS = 300;
/** After this many backlog entries on subscribe, upload a snapshot so the relay can drop them. */
const COMPACT_AFTER = 100;

interface Handle {
  name: string;
  doc: Y.Doc;
  seq: number;
  pending: Uint8Array | null;
  inflight: { ref: string; update: Uint8Array } | null;
  docId: string | null;
  synced: boolean;
  backlog: number;
  saveTimer: ReturnType<typeof setTimeout> | null;
}

export class SyncEngine {
  private handles = new Map<string, Handle>();
  private byDocId = new Map<string, Handle>();
  private session: Session | null = null;
  private keys: SessionKeys | null = null;
  private ws: WebSocket | null = null;
  private retry = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private inbound: Promise<void> = Promise.resolve();
  private listeners = new Set<(s: SyncStatus) => void>();
  private refCounter = 0;
  status: SyncStatus = "local-only";

  constructor() {
    addEventListener("online", () => this.reconnectNow());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") this.flushAll();
      else this.reconnectNow();
    });
    addEventListener("pagehide", () => this.flushAll());
  }

  onStatus(fn: (s: SyncStatus) => void): () => void {
    this.listeners.add(fn);
    fn(this.status);
    return () => this.listeners.delete(fn);
  }

  private setStatus(s: SyncStatus) {
    this.status = s;
    this.listeners.forEach((fn) => fn(s));
  }

  // ---------- docs ----------

  async open(name: string): Promise<Y.Doc> {
    const existing = this.handles.get(name);
    if (existing) return existing.doc;
    const doc = new Y.Doc();
    const rec = await localStore.get(name);
    // Another caller may have opened it while we awaited.
    const raced = this.handles.get(name);
    if (raced) return raced.doc;
    if (rec) Y.applyUpdate(doc, rec.state, REMOTE);
    const h: Handle = {
      name,
      doc,
      seq: rec?.seq ?? 0,
      pending: rec?.pending ?? null,
      inflight: null,
      docId: null,
      synced: false,
      backlog: 0,
      saveTimer: null,
    };
    this.handles.set(name, h);
    doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin !== REMOTE) {
        h.pending = h.pending ? Y.mergeUpdates([h.pending, update]) : update;
        this.push(h);
      }
      this.scheduleSave(h);
    });
    if (this.keys) await this.attach(h);
    return doc;
  }

  private scheduleSave(h: Handle) {
    if (h.saveTimer) clearTimeout(h.saveTimer);
    h.saveTimer = setTimeout(() => this.save(h), SAVE_DELAY_MS);
  }

  private save(h: Handle) {
    if (h.saveTimer) clearTimeout(h.saveTimer);
    h.saveTimer = null;
    const unacked = [h.inflight?.update, h.pending].filter((u): u is Uint8Array => !!u);
    void localStore.put({
      name: h.name,
      state: Y.encodeStateAsUpdate(h.doc),
      seq: h.seq,
      pending: unacked.length ? Y.mergeUpdates(unacked) : null,
    });
  }

  private flushAll() {
    for (const h of this.handles.values()) if (h.saveTimer) this.save(h);
  }

  // ---------- session / connection ----------

  async setSession(session: Session | null, opts: { switched?: boolean } = {}): Promise<void> {
    this.disconnect();
    this.session = session;
    this.keys = null;
    this.byDocId.clear();
    if (opts.switched) {
      this.flushAll();
      await localStore.resetSync();
      for (const h of this.handles.values()) {
        h.seq = 0;
        h.pending = Y.encodeStateAsUpdate(h.doc);
      }
    }
    if (!session) {
      this.setStatus("local-only");
      return;
    }
    this.keys = await deriveKeys(session.secret);
    for (const h of this.handles.values()) await this.attach(h);
    this.connect();
  }

  private async attach(h: Handle) {
    if (!this.keys) return;
    h.docId = await opaqueDocId(this.keys, h.name);
    this.byDocId.set(h.docId, h);
    this.subscribe(h);
  }

  private connect() {
    if (!this.session || !this.keys) return;
    this.setStatus("connecting");
    const url = `${this.session.relay.replace(/\/+$/, "")}/v1/rooms/${this.keys.roomId}`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.setStatus("online");
      for (const h of this.handles.values()) this.subscribe(h);
    };
    ws.onmessage = (ev) => {
      const msg = parseServerMsg(String(ev.data));
      if (msg) this.inbound = this.inbound.then(() => this.receive(msg)).catch((e) => console.error(e));
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      for (const h of this.handles.values()) this.requeue(h);
      this.setStatus("offline");
      this.scheduleReconnect();
    };
  }

  private disconnect() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    for (const h of this.handles.values()) this.requeue(h);
  }

  private scheduleReconnect() {
    if (this.retryTimer || !this.session) return;
    const delay = Math.min(30_000, 500 * 2 ** this.retry++) * (0.5 + Math.random() / 2);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  private reconnectNow() {
    if (this.session && !this.ws) {
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = null;
      this.retry = 0;
      this.connect();
    }
  }

  /** Puts an unacknowledged push back into the queue so it is resent after reconnecting. */
  private requeue(h: Handle) {
    h.synced = false;
    if (h.inflight) {
      h.pending = h.pending ? Y.mergeUpdates([h.inflight.update, h.pending]) : h.inflight.update;
      h.inflight = null;
    }
  }

  private send(msg: ClientMsg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  // ---------- protocol ----------

  private subscribe(h: Handle) {
    if (!h.docId || this.ws?.readyState !== WebSocket.OPEN) return;
    h.synced = false;
    h.backlog = 0;
    this.send({ t: "sub", doc: h.docId, since: h.seq });
  }

  private push(h: Handle) {
    if (!h.synced || h.inflight || !h.pending || !h.docId || !this.keys) return;
    const update = h.pending;
    const ref = String(++this.refCounter);
    h.pending = null;
    h.inflight = { ref, update };
    const { keys, docId } = { keys: this.keys, docId: h.docId };
    void seal(keys, docId, update).then((data) => {
      if (h.inflight?.ref === ref) this.send({ t: "push", doc: docId, ref, data });
    });
  }

  private async receive(msg: ServerMsg) {
    if (msg.t === "err") {
      console.warn(`relay: ${msg.code}: ${msg.msg}`);
      return;
    }
    const h = this.byDocId.get(msg.doc);
    if (!h || !this.keys) return;
    switch (msg.t) {
      case "snap":
      case "upd": {
        const plain = await open(this.keys, msg.doc, msg.data);
        if (plain) Y.applyUpdate(h.doc, plain, REMOTE);
        else console.warn("dropped an update that does not decrypt with this session key");
        h.seq = Math.max(h.seq, msg.seq);
        if (msg.t === "upd" && !h.synced) h.backlog++;
        this.scheduleSave(h);
        return;
      }
      case "synced": {
        h.synced = true;
        if (h.backlog >= COMPACT_AFTER && h.seq > 0) {
          const data = await seal(this.keys, msg.doc, Y.encodeStateAsUpdate(h.doc));
          this.send({ t: "compact", doc: msg.doc, upTo: h.seq, data });
        }
        this.push(h);
        return;
      }
      case "ack": {
        if (h.inflight?.ref !== msg.ref) return;
        h.inflight = null;
        // The relay sends in append order, so every update before this seq has already arrived.
        h.seq = Math.max(h.seq, msg.seq);
        this.scheduleSave(h);
        this.push(h);
        return;
      }
    }
  }
}

export const engine = new SyncEngine();
