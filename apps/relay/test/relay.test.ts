import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { WebSocket } from "ws";
import type { ServerMsg } from "@notes-hq/protocol";
import { startRelay, type RunningRelay } from "../src/server/server.js";

const ROOM = "room_aaaaaaaaaaaaaaaa";
const DOC = "doc_bbbbbbbbbbbbbbbbb";
let relay: RunningRelay;
let dir: string;
let url: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "notes-hq-relay-"));
  relay = await startRelay({
    host: "127.0.0.1",
    port: 0,
    dataDir: dir,
    staticDir: null,
    allowedOrigins: [],
    maxDataBytes: 1024,
    maxSubsPerPeer: 100,
  });
  const addr = relay.server.address();
  assert(addr && typeof addr === "object");
  url = `ws://127.0.0.1:${addr.port}/v1/rooms/${ROOM}`;
});

after(async () => {
  await relay.close();
  rmSync(dir, { recursive: true, force: true });
});

class Client {
  ws: WebSocket;
  inbox: ServerMsg[] = [];
  private waiters: (() => void)[] = [];
  constructor(u = url) {
    this.ws = new WebSocket(u);
    this.ws.on("message", (d) => {
      this.inbox.push(JSON.parse(d.toString()));
      this.waiters.splice(0).forEach((w) => w());
    });
  }
  open() {
    return new Promise<void>((r, j) => {
      this.ws.once("open", () => r());
      this.ws.once("error", j);
    });
  }
  send(m: object) {
    this.ws.send(JSON.stringify(m));
  }
  async waitFor(pred: (m: ServerMsg) => boolean): Promise<ServerMsg> {
    for (;;) {
      const i = this.inbox.findIndex(pred);
      if (i >= 0) return this.inbox.splice(i, 1)[0]!;
      await new Promise<void>((r, j) => {
        this.waiters.push(r);
        setTimeout(() => j(new Error("timeout waiting for message")), 2000);
      });
    }
  }
  close() {
    this.ws.close();
  }
}

test("forwards updates live and replays backlog with snapshot", async () => {
  const a = new Client();
  const b = new Client();
  await Promise.all([a.open(), b.open()]);
  a.send({ t: "sub", doc: DOC, since: 0 });
  b.send({ t: "sub", doc: DOC, since: 0 });
  await a.waitFor((m) => m.t === "synced");
  await b.waitFor((m) => m.t === "synced");

  a.send({ t: "push", doc: DOC, ref: "r1", data: "AAAA" });
  assert.deepEqual(await a.waitFor((m) => m.t === "ack"), { t: "ack", doc: DOC, ref: "r1", seq: 1 });
  assert.deepEqual(await b.waitFor((m) => m.t === "upd"), { t: "upd", doc: DOC, seq: 1, data: "AAAA" });
  assert.equal(a.inbox.filter((m) => m.t === "upd").length, 0, "sender does not get its own update back");

  b.send({ t: "push", doc: DOC, ref: "r2", data: "BBBB" });
  await b.waitFor((m) => m.t === "ack");

  // Late joiner gets the full log.
  const c = new Client();
  await c.open();
  c.send({ t: "sub", doc: DOC, since: 0 });
  assert.equal(((await c.waitFor((m) => m.t === "upd")) as { seq: number }).seq, 1);
  assert.equal(((await c.waitFor((m) => m.t === "upd")) as { seq: number }).seq, 2);
  assert.equal(((await c.waitFor((m) => m.t === "synced")) as { seq: number }).seq, 2);

  // Compact, then a new device receives the snapshot instead of old entries.
  a.send({ t: "compact", doc: DOC, upTo: 2, data: "SNAP" });
  a.send({ t: "push", doc: DOC, ref: "r3", data: "CCCC" });
  await a.waitFor((m) => m.t === "ack");
  const d = new Client();
  await d.open();
  d.send({ t: "sub", doc: DOC, since: 0 });
  assert.deepEqual(await d.waitFor((m) => m.t === "snap"), { t: "snap", doc: DOC, seq: 2, data: "SNAP" });
  assert.deepEqual(await d.waitFor((m) => m.t === "upd"), { t: "upd", doc: DOC, seq: 3, data: "CCCC" });

  // A device that is already up to date gets nothing but `synced`.
  const e = new Client();
  await e.open();
  e.send({ t: "sub", doc: DOC, since: 3 });
  assert.deepEqual(await e.waitFor(() => true), { t: "synced", doc: DOC, seq: 3 });

  for (const x of [a, b, c, d, e]) x.close();
});

test("rejects malformed and oversized frames", async () => {
  const a = new Client();
  await a.open();
  a.send({ t: "push", doc: "short", ref: "x", data: "AAAA" });
  assert.equal(((await a.waitFor((m) => m.t === "err")) as { code: string }).code, "bad_message");
  a.send({ t: "push", doc: DOC, ref: "x", data: "A".repeat(1025) });
  assert.equal(((await a.waitFor((m) => m.t === "err")) as { code: string }).code, "too_large");
  a.close();
});
