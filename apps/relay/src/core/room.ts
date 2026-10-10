import { parseClientMsg, type ServerMsg } from "@notes-hq/protocol";
import type { RoomStore } from "./store.js";

/**
 * A connected device. Runtimes adapt their socket type to this interface.
 * Subscriptions live on the peer (not in a room object) so that runtimes which
 * evict memory between messages, like hibernating Durable Objects, can persist them.
 */
export interface Peer {
  send(msg: ServerMsg): void;
  getSubs(): Set<string>;
  setSubs(subs: Set<string>): void;
}

export interface Limits {
  maxDataBytes: number;
  maxSubsPerPeer: number;
}

/**
 * Handles one frame from `from`. Stateless apart from the store and the peers'
 * subscriptions, so it can run after a cold start.
 */
export function handleFrame(
  store: RoomStore,
  from: Peer,
  peers: Iterable<Peer>,
  raw: string,
  limits: Limits,
): void {
  if (raw.length > limits.maxDataBytes + 1024) {
    from.send({ t: "err", code: "too_large", msg: "frame too large" });
    return;
  }
  const msg = parseClientMsg(raw);
  if (!msg) {
    from.send({ t: "err", code: "bad_message", msg: "malformed frame" });
    return;
  }

  switch (msg.t) {
    case "sub": {
      const subs = from.getSubs();
      if (!subs.has(msg.doc) && subs.size >= limits.maxSubsPerPeer) {
        from.send({ t: "err", code: "bad_message", msg: "too many subscriptions" });
        return;
      }
      subs.add(msg.doc);
      from.setSubs(subs);
      const { snapshot, entries } = store.read(msg.doc, msg.since);
      if (snapshot) from.send({ t: "snap", doc: msg.doc, seq: snapshot.seq, data: snapshot.data });
      for (const e of entries) from.send({ t: "upd", doc: msg.doc, seq: e.seq, data: e.data });
      from.send({ t: "synced", doc: msg.doc, seq: store.head(msg.doc) });
      return;
    }
    case "unsub": {
      const subs = from.getSubs();
      subs.delete(msg.doc);
      from.setSubs(subs);
      return;
    }
    case "push": {
      if (msg.data.length > limits.maxDataBytes) {
        from.send({ t: "err", code: "too_large", msg: "update too large" });
        return;
      }
      const seq = store.append(msg.doc, msg.data);
      from.send({ t: "ack", doc: msg.doc, ref: msg.ref, seq });
      for (const p of peers) {
        if (p !== from && p.getSubs().has(msg.doc)) p.send({ t: "upd", doc: msg.doc, seq, data: msg.data });
      }
      return;
    }
    case "compact": {
      if (msg.data.length > limits.maxDataBytes) {
        from.send({ t: "err", code: "too_large", msg: "snapshot too large" });
        return;
      }
      if (!store.compact(msg.doc, msg.upTo, msg.data)) {
        from.send({ t: "err", code: "bad_compact", msg: "stale or invalid compaction" });
      }
      return;
    }
  }
}
