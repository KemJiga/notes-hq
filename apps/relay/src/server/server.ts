import { mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WebSocketServer, type WebSocket } from "ws";
import { ID_PATTERN, type ServerMsg } from "@notes-hq/protocol";
import { handleFrame, migrate, RoomStore, type Peer, type Sql } from "../core/index.js";
import type { Config } from "./config.js";
import { serveStatic } from "./static.js";

const ROOM_PATH = /^\/v1\/rooms\/([A-Za-z0-9_-]+)$/;

class NodePeer implements Peer {
  private subs = new Set<string>();
  alive = true;
  constructor(readonly ws: WebSocket) {}
  send(msg: ServerMsg): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(msg));
  }
  getSubs(): Set<string> {
    return this.subs;
  }
  setSubs(subs: Set<string>): void {
    this.subs = subs;
  }
}

export interface RunningRelay {
  server: Server;
  close(): Promise<void>;
}

export function startRelay(config: Config): Promise<RunningRelay> {
  mkdirSync(config.dataDir, { recursive: true });
  const db = new DatabaseSync(join(config.dataDir, "relay.sqlite"));
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
  const sql: Sql = (query, ...params) => {
    const stmt = db.prepare(query);
    return /^\s*(SELECT|WITH)/i.test(query) ? (stmt.all(...params) as Record<string, unknown>[]) : (stmt.run(...params), []);
  };
  migrate(sql);

  const rooms = new Map<string, Set<NodePeer>>();
  const limits = { maxDataBytes: config.maxDataBytes, maxSubsPerPeer: config.maxSubsPerPeer };

  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (path === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }
    if (config.staticDir && (req.method === "GET" || req.method === "HEAD")) {
      serveStatic(config.staticDir, req, res);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" }).end("notes-hq relay");
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: config.maxDataBytes + 4096 });

  server.on("upgrade", (req, socket, head) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const match = ROOM_PATH.exec(path);
    const origin = req.headers.origin;
    const originOk = config.allowedOrigins.length === 0 || (origin !== undefined && config.allowedOrigins.includes(origin));
    if (!match || !ID_PATTERN.test(match[1]!) || !originOk) {
      socket.write(`HTTP/1.1 ${originOk ? 404 : 403} ${originOk ? "Not Found" : "Forbidden"}\r\n\r\n`);
      socket.destroy();
      return;
    }
    const roomId = match[1]!;
    wss.handleUpgrade(req, socket, head, (ws) => {
      const peer = new NodePeer(ws);
      const store = new RoomStore(sql, roomId);
      let peers = rooms.get(roomId);
      if (!peers) rooms.set(roomId, (peers = new Set()));
      peers.add(peer);

      ws.on("pong", () => (peer.alive = true));
      ws.on("message", (data, isBinary) => {
        if (isBinary) {
          peer.send({ t: "err", code: "bad_message", msg: "text frames only" });
          return;
        }
        try {
          handleFrame(store, peer, peers, data.toString(), limits);
        } catch (err) {
          console.error("relay error", err);
          peer.send({ t: "err", code: "unavailable", msg: "internal error" });
        }
      });
      ws.on("close", () => {
        peers.delete(peer);
        if (peers.size === 0) rooms.delete(roomId);
      });
    });
  });

  // Drop connections that stop answering pings (sleeping phones, dead networks).
  const heartbeat = setInterval(() => {
    for (const peers of rooms.values()) {
      for (const p of peers) {
        if (!p.alive) p.ws.terminate();
        else {
          p.alive = false;
          p.ws.ping();
        }
      }
    }
  }, 30_000);

  return new Promise((resolveStart) => {
    server.listen(config.port, config.host, () => {
      resolveStart({
        server,
        close: () =>
          new Promise<void>((done) => {
            clearInterval(heartbeat);
            for (const ws of wss.clients) ws.terminate();
            wss.close();
            server.close(() => {
              db.close();
              done();
            });
          }),
      });
    });
  });
}
