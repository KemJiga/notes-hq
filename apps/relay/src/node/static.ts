import { createReadStream, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

/** Minimal static file server with SPA fallback to index.html. */
export function serveStatic(root: string, req: IncomingMessage, res: ServerResponse): void {
  const base = resolve(root);
  const urlPath = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
  let file = resolve(join(base, normalize(urlPath)));
  if (file !== base && !file.startsWith(base + sep)) {
    res.writeHead(403).end();
    return;
  }
  let st = safeStat(file);
  if (st?.isDirectory()) {
    file = join(file, "index.html");
    st = safeStat(file);
  }
  if (!st?.isFile()) {
    file = join(base, "index.html");
    st = safeStat(file);
    if (!st?.isFile()) {
      res.writeHead(404).end("not found");
      return;
    }
  }
  const ext = extname(file);
  const immutable = urlPath.startsWith("/assets/");
  res.writeHead(200, {
    "content-type": TYPES[ext] ?? "application/octet-stream",
    "content-length": st.size,
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
  });
  if (req.method === "HEAD") res.end();
  else createReadStream(file).pipe(res);
}

function safeStat(p: string) {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}
