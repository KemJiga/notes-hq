import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { Readable } from "node:stream";
import { isPublicIp, type Fetcher } from "../core/index.js";

/**
 * Resolves like dns.lookup but fails if ANY address is not public. The socket
 * connects to the addresses checked here, so DNS rebinding can't slip past it.
 */
export const guardedLookup = ((host: string, opts: { all?: boolean }, cb: (...args: unknown[]) => void) => {
  dnsLookup(host, { ...opts, all: true }, (err, addrs: LookupAddress[]) => {
    if (err) return cb(err);
    if (addrs.length === 0 || addrs.some((a) => !isPublicIp(a.address))) return cb(Object.assign(new Error("blocked address"), { code: "EBLOCKED" }));
    if (opts.all) cb(null, addrs);
    else cb(null, addrs[0]!.address, addrs[0]!.family);
  });
}) as unknown as LookupFunction;

/** One GET, no redirects, connecting only to public IPs. */
export const nodeFetcher: Fetcher = (url, signal) =>
  new Promise((resolve, reject) => {
    const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        method: "GET",
        lookup: guardedLookup,
        signal,
        headers: { "user-agent": "notes-hq-unfurl/1 (link preview)", accept: "text/html,application/xhtml+xml,image/*;q=0.9,*/*;q=0.5" },
      },
      (res: IncomingMessage) => {
        // A throw here would be uncaught and take the whole relay down.
        try {
          const headers = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            for (const x of Array.isArray(v) ? v : v === undefined ? [] : [v]) headers.append(k, x);
          }
          const status = res.statusCode ?? 0;
          const empty = status === 204 || status === 304;
          if (empty) res.resume();
          resolve(new Response(empty ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), { status, headers }));
        } catch (err) {
          res.destroy();
          reject(err);
        }
      },
    );
    req.on("error", reject);
    req.end();
  });
