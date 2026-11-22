import assert from "node:assert/strict";
import { test } from "node:test";
import { embedUrl, isHttpUrl, unfurlEndpoint } from "../src/previews";

test("embedUrl: YouTube and Vimeo only, privacy-friendly players", () => {
  const yt = "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1";
  for (const u of [
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=42",
    "https://youtu.be/dQw4w9WgXcQ?si=abc",
    "https://youtube.com/shorts/dQw4w9WgXcQ",
  ]) assert.equal(embedUrl(u), yt, u);
  assert.equal(embedUrl("https://vimeo.com/76979871"), "https://player.vimeo.com/video/76979871?autoplay=1&dnt=1");
  for (const u of ["https://youtube.com/watch?v=short", "https://youtube.com/@channel", "https://vimeo.com/channels/staffpicks", "https://notyoutube.com/watch?v=dQw4w9WgXcQ", "nope"])
    assert.equal(embedUrl(u), null, u);
});

test("isHttpUrl: a bare link to a dotted host", () => {
  for (const u of ["https://example.com", "http://a.b/c?d=e#f"]) assert(isHttpUrl(u), u);
  for (const u of ["example.com", "https://localhost/", "javascript:alert(1)", "https://a.com b", "ftp://a.com/"]) assert(!isHttpUrl(u), u);
});

test("unfurlEndpoint follows the relay URL like the sync socket does", () => {
  assert.equal(unfurlEndpoint("wss://relay.example/", "https://a.com/?x=1&y"), "https://relay.example/v1/unfurl?url=https%3A%2F%2Fa.com%2F%3Fx%3D1%26y");
  assert.equal(unfurlEndpoint("ws://localhost:8787/base", "https://a.com"), "http://localhost:8787/base/v1/unfurl?url=https%3A%2F%2Fa.com");
});
