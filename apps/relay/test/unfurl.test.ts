import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { isPublicIp, parseMeta, unfurl, UnfurlError, type Fetcher } from "../src/core/index.js";
import { guardedLookup } from "../src/server/fetcher.js";
import { startRelay, type RunningRelay } from "../src/server/server.js";

/** A fake internet: URL → response factory. Records every URL it was asked for. */
function fakeWeb(pages: Record<string, () => Response>): Fetcher & { asked: string[] } {
  const asked: string[] = [];
  const f: Fetcher = async (url) => {
    asked.push(url.href);
    const page = pages[url.href];
    return page ? page() : new Response("nope", { status: 404 });
  };
  return Object.assign(f, { asked });
}
const html = (body: string) => () => new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });

test("isPublicIp", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8", "2002:808:808::1"]) assert.equal(isPublicIp(ip), true, ip);
  for (const ip of [
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
    "224.0.0.1", "255.255.255.255", "::", "::1", "[::1]", "fe80::1", "fd00::1", "fc00::1", "ff02::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::a00:1", "2002:7f00:1::1", "2001:db8::1", "2001::1", "not-an-ip", "1.2.3",
  ]) assert.equal(isPublicIp(ip), false, ip);
});

test("parses Open Graph first, then Twitter, then plain HTML", () => {
  const base = new URL("https://example.com/post/1");
  assert.deepEqual(
    parseMeta(
      `<html><head><title>Plain</title>
       <meta property="og:title" content="OG &amp; title">
       <meta name="twitter:title" content="Twitter title">
       <meta name='description' content='Plain description'>
       <meta content="Site" property="og:site_name">
       <meta property="og:image" content="/img/a.png">
       <link rel="alternate" type="application/json+oembed" href="https://example.com/oembed?u=1&amp;f=json">`,
      base,
    ),
    {
      title: "OG & title",
      description: "Plain description",
      siteName: "Site",
      image: "https://example.com/img/a.png",
      oembed: "https://example.com/oembed?u=1&f=json",
    },
  );
  assert.deepEqual(parseMeta(`<title>  Only &#x27;a&#39;\n title </title><meta name="twitter:image" content="javascript:alert(1)">`, base), {
    title: "Only 'a' title",
    description: undefined,
    siteName: undefined,
    image: undefined,
    oembed: undefined,
  });
});

test("parsing is linear on hostile markup and ignores the body", () => {
  const base = new URL("https://example.com/");
  for (const evil of ["<meta".repeat(200_000), "<meta<meta".repeat(100_000) + ">", "<title".repeat(200_000), `<meta ${"a".repeat(1_000_000)}>`]) {
    const t0 = performance.now();
    parseMeta(evil, base);
    assert(performance.now() - t0 < 500, `took ${performance.now() - t0}ms`);
  }
  const page = `<head><title>Tips &constructor; &amp; tricks</title><meta charset="utf-8"></head><body><meta property="og:title" content="Body">`;
  assert.equal(parseMeta(page, base).title, "Tips &constructor; & tricks");
});

test("decodes pages by <meta charset> when the header has none", async () => {
  const bytes = new Uint8Array([...new TextEncoder().encode('<meta charset="windows-1252"><title>Caf'), 0xe9, ...new TextEncoder().encode("</title>")]);
  const web = fakeWeb({ "https://cafe.example/": () => new Response(bytes, { headers: { "content-type": "text/html" } }) });
  assert.equal((await unfurl("https://cafe.example/", web)).title, "Café");
});

test("unfurls a page, inlines its image and fills gaps from oEmbed", async () => {
  const web = fakeWeb({
    "https://video.example/watch": html(
      `<meta property="og:description" content="Desc"><link type="application/json+oembed" href="/oembed">`,
    ),
    "https://video.example/oembed": () => Response.json({ title: "From oEmbed", provider_name: "VideoSite", thumbnail_url: "https://img.example/t.jpg" }),
    "https://img.example/t.jpg": () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/jpeg" } }),
  });
  assert.deepEqual(await unfurl("https://video.example/watch", web), {
    url: "https://video.example/watch",
    title: "From oEmbed",
    description: "Desc",
    siteName: "VideoSite",
    image: "data:image/jpeg;base64,AQID",
  });
});

test("drops images that are not raster images", async () => {
  const web = fakeWeb({
    "https://a.example/": html(`<meta property="og:title" content="T"><meta property="og:image" content="https://a.example/x.svg">`),
    "https://a.example/x.svg": () => new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } }),
  });
  assert.deepEqual(await unfurl("https://a.example/", web), { url: "https://a.example/", title: "T" });
});

test("follows redirects but re-checks every hop", async () => {
  const web = fakeWeb({
    "https://short.example/x": () => new Response(null, { status: 301, headers: { location: "https://long.example/article" } }),
    "https://long.example/article": html(`<meta property="og:title" content="Article">`),
    "https://evil.example/": () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } }),
  });
  assert.deepEqual(await unfurl("https://short.example/x", web), { url: "https://long.example/article", title: "Article" });
  await assert.rejects(unfurl("https://evil.example/", web), (e: UnfurlError) => e.status === 400);
  assert(!web.asked.some((u) => u.includes("169.254")), "never fetched the metadata address");
});

test("rejects bad targets without fetching", async () => {
  const web = fakeWeb({});
  for (const u of [
    "file:///etc/passwd", "ftp://example.com/", "javascript:alert(1)", "http://127.0.0.1/", "http://2130706433/", "http://0x7f.1/",
    "http://[::1]/", "http://[::ffff:10.0.0.1]/", "http://localhost/", "http://foo.localhost/", "http://router/", "http://nas.local/",
    "http://localhost./", "http://nas.local./", "http://metadata.google.internal./", "http://127.0.0.1./",
    "https://example.com:8443/", "https://user:pw@example.com/", "not a url",
  ]) {
    await assert.rejects(unfurl(u, web), (e: UnfurlError) => e.status === 400, u);
  }
  assert.deepEqual(web.asked, []);
});

test("caps size and time", async () => {
  // Pages are read up to 1 MB and parsed from there; anything after the cap is never seen.
  const big = fakeWeb({
    "https://big.example/": html(`<meta property="og:title" content="Head">` + "x".repeat(1024 * 1024) + `<meta property="og:description" content="Tail">`),
  });
  assert.deepEqual(await unfurl("https://big.example/", big), { url: "https://big.example/", title: "Head" });
  // Images past the cap are dropped, even when Content-Length lies about the size.
  const images = fakeWeb({
    "https://img.example/": html(`<meta property="og:title" content="T"><meta property="og:image" content="/a.png"><meta property="twitter:image" content="/b.png">`),
    "https://img.example/a.png": () => new Response(new Uint8Array(1024 * 1024 + 1), { headers: { "content-type": "image/png" } }),
  });
  assert.deepEqual(await unfurl("https://img.example/", images), { url: "https://img.example/", title: "T" });
  const lying = fakeWeb({
    "https://lie.example/": html(`<meta property="og:image" content="/a.png">`),
    "https://lie.example/a.png": () => new Response("tiny", { headers: { "content-type": "image/png", "content-length": "99999999" } }),
  });
  assert.deepEqual(await unfurl("https://lie.example/", lying), { url: "https://lie.example/" });
  const hang: Fetcher = (_url, signal) =>
    new Promise((_r, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
  const t0 = Date.now();
  await assert.rejects(unfurl("https://slow.example/", hang, 50));
  assert(Date.now() - t0 < 1000);
});

test("guarded DNS lookup refuses names that resolve to private addresses", async () => {
  const err = await new Promise<Error | null>((r) => guardedLookup("localhost", { all: true }, (e) => r(e)));
  assert.match(String(err?.message), /blocked/);
});

// ---------- the endpoint on the Node relay ----------

let relay: RunningRelay;
let dir: string;
let base: string;
let local: Server;
let localHits = 0;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "notes-hq-unfurl-"));
  relay = await startRelay({
    host: "127.0.0.1", port: 0, dataDir: dir, staticDir: null,
    allowedOrigins: ["https://notes.example"], maxDataBytes: 1024, maxSubsPerPeer: 100, unfurlEnabled: true,
  });
  const addr = relay.server.address();
  assert(addr && typeof addr === "object");
  base = `http://127.0.0.1:${addr.port}`;
  local = createServer((_q, s) => (localHits++, s.end("<title>secret</title>")));
  await new Promise<void>((r) => local.listen(0, "127.0.0.1", r));
});

after(async () => {
  await relay.close();
  local.close();
  rmSync(dir, { recursive: true, force: true });
});

const call = (target: string, origin?: string) =>
  fetch(`${base}/v1/unfurl?url=${encodeURIComponent(target)}`, origin ? { headers: { origin } } : {});

test("endpoint blocks local targets and honours the origin allow-list", async () => {
  const addr = local.address();
  assert(addr && typeof addr === "object");
  const res = await call(`http://127.0.0.1:${addr.port}/`, "https://notes.example");
  assert.equal(res.status, 400);
  assert.equal(res.headers.get("access-control-allow-origin"), "https://notes.example");
  assert.equal(res.headers.get("cache-control"), "no-store");
  for (const u of ["http://localhost/", "http://127.0.0.1/", "http://[::1]/", "http://169.254.169.254/"]) assert.equal((await call(u, "https://notes.example")).status, 400, u);
  assert.equal(localHits, 0, "the relay never reached the local server");
  assert.equal((await call("https://example.com/", "https://evil.example")).status, 403);
  // With an allow-list, a request without Origin must at least look same-origin (as browsers send it).
  const bare = `${base}/v1/unfurl?url=${encodeURIComponent("http://127.0.0.1/")}`;
  assert.equal((await fetch(bare)).status, 403);
  assert.equal((await fetch(bare, { headers: { "sec-fetch-site": "same-origin" } })).status, 400);
});

test("endpoint is off unless enabled, even next to the app's SPA fallback", async () => {
  writeFileSync(join(dir, "index.html"), "<!doctype html>app");
  const off = await startRelay({
    host: "127.0.0.1", port: 0, dataDir: dir, staticDir: dir,
    allowedOrigins: [], maxDataBytes: 1024, maxSubsPerPeer: 100, unfurlEnabled: false,
  });
  const addr = off.server.address();
  assert(addr && typeof addr === "object");
  assert.equal((await fetch(`http://127.0.0.1:${addr.port}/v1/unfurl?url=https%3A%2F%2Fexample.com`)).status, 404);
  await off.close();
});
