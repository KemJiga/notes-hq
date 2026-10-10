/**
 * OPTIONAL Cloudflare adapter. The self-hosted relay (src/server) is the reference
 * runtime; this file lets the same core run on Cloudflare Workers + SQLite-backed
 * Durable Objects (available on the Workers Free plan) for people who prefer it.
 *
 * One Durable Object per room. Uses the WebSocket Hibernation API so idle rooms
 * cost nothing; all state lives in the object's SQLite storage, never in memory.
 */
import { DurableObject } from "cloudflare:workers";
import { DEFAULT_MAX_DATA_BYTES, ID_PATTERN, type ServerMsg } from "@notes-hq/protocol";
import { handleFrame, migrate, RoomStore, type Peer, type Sql } from "../core/index.js";

export interface Env {
  ROOMS: DurableObjectNamespace<Room>;
  ALLOWED_ORIGINS?: string;
  MAX_DATA_BYTES?: string;
}

const ROOM_PATH = /^\/v1\/rooms\/([A-Za-z0-9_-]+)$/;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") return new Response("ok");
    const match = ROOM_PATH.exec(url.pathname);
    if (!match || !ID_PATTERN.test(match[1]!)) return new Response("notes-hq relay", { status: 404 });
    if (req.headers.get("upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const allowed = (env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const origin = req.headers.get("origin");
    if (allowed.length > 0 && (!origin || !allowed.includes(origin))) return new Response("forbidden", { status: 403 });
    const stub = env.ROOMS.get(env.ROOMS.idFromName(match[1]!));
    return stub.fetch(req);
  },
} satisfies ExportedHandler<Env>;

interface Attachment {
  peer: string;
  room: string;
}

export class Room extends DurableObject<Env> {
  private readonly sql: Sql;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = (query, ...params) => ctx.storage.sql.exec(query, ...params).toArray() as Record<string, unknown>[];
    migrate(this.sql);
    // Subscriptions are persisted because hibernation clears memory and
    // socket attachments are limited to 2 KB.
    this.sql("CREATE TABLE IF NOT EXISTS subs (peer TEXT NOT NULL, doc TEXT NOT NULL, PRIMARY KEY (peer, doc)) WITHOUT ROWID");
  }

  async fetch(req: Request): Promise<Response> {
    const room = ROOM_PATH.exec(new URL(req.url).pathname)![1]!;
    const pair = new WebSocketPair();
    const att: Attachment = { peer: crypto.randomUUID(), room };
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment(att);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private peer(ws: WebSocket): Peer {
    const { peer } = ws.deserializeAttachment() as Attachment;
    const sql = this.sql;
    return {
      send: (msg: ServerMsg) => {
        try {
          ws.send(JSON.stringify(msg));
        } catch {
          /* socket already closed */
        }
      },
      getSubs: () => new Set(sql("SELECT doc FROM subs WHERE peer = ?", peer).map((r) => String(r.doc))),
      setSubs: (subs) => {
        sql("DELETE FROM subs WHERE peer = ?", peer);
        for (const doc of subs) sql("INSERT INTO subs (peer, doc) VALUES (?, ?)", peer, doc);
      },
    };
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const from = this.peer(ws);
    if (typeof message !== "string") {
      from.send({ t: "err", code: "bad_message", msg: "text frames only" });
      return;
    }
    const { room } = ws.deserializeAttachment() as Attachment;
    const peers = this.ctx.getWebSockets().map((s) => (s === ws ? from : this.peer(s)));
    const maxDataBytes = Number(this.env.MAX_DATA_BYTES) || DEFAULT_MAX_DATA_BYTES;
    handleFrame(new RoomStore(this.sql, room), from, peers, message, { maxDataBytes, maxSubsPerPeer: 10_000 });
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const { peer } = ws.deserializeAttachment() as Attachment;
    this.sql("DELETE FROM subs WHERE peer = ?", peer);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }
}
