# notes-hq design

This document records what notes-hq is trying to be, the decisions made so far, and why. It is written for anyone who wants to run, fork, or contribute to the project. When a decision changes, update it here, and keep the old reasoning under a "Superseded" note so the history stays readable.

Status: **early scaffold (v0.1)**. The sync core works end to end. The editor, the archive features, and the polish do not exist yet.

---

## 1. Context

notes-hq is a notes app that becomes a **personal archive**. You write notes on any device you own, such as a PC, laptop, phone, or tablet, and they stay in sync across all of them. Later the same archive should hold things saved from elsewhere: links, blog posts, videos, social media posts.

Guiding requirements:

| Requirement | What it means in practice |
|---|---|
| **Light and fast** | The UI never waits on the network. Startup doesn't slow down as the archive grows. The app bundle stays small. |
| **Every device** | One codebase that runs and installs on desktop and mobile. |
| **Your data stays yours** | Notes live on your devices. Anything that leaves a device is end-to-end encrypted. |
| **No accounts (for now)** | No sign-up or login. Only devices you add can sync. |
| **No provider or device lock-in** | Anyone can host it on their own terms: a home server on the LAN, a VPS, a container platform, or a serverless edge. No piece of the system depends on a specific vendor. |
| **No size limit on notes** | Note bodies are unbounded text. Large notes must not slow down the rest of the app. |

### Non-goals (for now)

- User accounts, multi-user sharing, and per-note permissions.
- Server-side features that need to read content, such as server search or previews. The server is blind by design.
- Native apps. They may come later as thin wrappers (see §4, D7).

---

## 2. Architecture at a glance

```
 ┌──────────── device (PWA) ─────────────┐                ┌──────── relay (you host it) ────────┐
 │                                       │                │                                     │
 │  UI (Preact) ──► Y.Doc per note ──┐   │   WebSocket    │  /v1/rooms/<roomId>                 │
 │                  Y.Doc "index"    │   │  (encrypted    │    append-only log of ciphertext    │
 │                        │          ├───┼──  updates) ───┼──► per (room, doc), plus snapshots  │
 │                 IndexedDB (state, │   │                │    broadcast to other devices       │
 │                 seq, pending)     │   │                │                                     │
 │                                   │   │                │  SQLite (node:sqlite on Bun, or a   │
 │   AES-GCM + HKDF (WebCrypto) ◄────┘   │                │   Durable Object's SQLite)          │
 └───────────────────────────────────────┘                └─────────────────────────────────────┘
```

Repository layout:

```
packages/protocol   wire types, validation, base64url (shared by app and relay)
apps/web            the installable web app (Vite + Preact + Yjs)
apps/relay          the relay
  src/core          runtime-agnostic store + message handling
  src/server        reference self-hosted server (runs on Bun; Node-compatible): node:sqlite + ws; can also serve the app
  src/cloudflare    optional runtime: Workers + SQLite-backed Durable Objects
docs/               this file, PROTOCOL.md, SELF_HOSTING.md
```

---

## 3. How sync works

1. **Every write is local first.** Edits apply to an in-memory Yjs document and are saved to IndexedDB (debounced). The UI only ever reads local state.
2. **Local edits are queued.** Each local Yjs update is merged into a per-doc `pending` buffer, which is persisted together with the doc state.
3. **When a sync session exists**, the device opens one WebSocket to the relay and subscribes to each open doc with the last sequence number (`seq`) it has applied.
4. **The relay replies with what the device is missing** (a snapshot if one exists, then later log entries), then `synced`.
5. **After `synced`, the device pushes `pending`.** It encrypts the update, sends it, and keeps it "in flight" until the relay acknowledges it with a `seq`. If the socket drops, the in-flight update returns to `pending` and is resent later. Yjs updates are idempotent, so resending is always safe.
6. **The relay broadcasts each accepted update** to the other subscribed devices, which decrypt it and apply it.
7. **Compaction.** When a device had to replay many log entries (≥100) on subscribe, it uploads an encrypted snapshot of the full doc. The relay then replaces those entries with the snapshot. This keeps catch-up fast and storage bounded without the relay ever reading content.

Concurrent edits from devices that were offline merge automatically (that's what the CRDT is for), so there are no "conflicted copy" files.

The exact wire format is in [PROTOCOL.md](./PROTOCOL.md).

---

## 4. Decisions

Each decision lists what was chosen, why, and what was considered.

### D1. Local-first

**Chosen:** each device holds a full copy of its notes and works fully offline. Sync is a background process.
**Why:** this is what makes the app feel fast (no spinners on read or write) and what makes it keep working on a plane, in a basement, or when the relay is down.
**Considered:** a classic client/server design, where the server is the source of truth. Rejected because it's slower, it breaks offline, and the server holds the data in plaintext.

### D2. Yjs as the CRDT

**Chosen:** [Yjs](https://github.com/yjs/yjs).
**Why:** it's small and fast, it handles very large documents well (which matters given the "no size limit" requirement), and it has mature bindings for the editors we are considering (CodeMirror 6, ProseMirror/Tiptap, Lexical).
**Considered:**
- Automerge: a nice data model, but it needs a WASM bundle and is heavier.
- Last-writer-wins records: simple, but it loses edits when two devices edit the same note offline.

### D3. Sync through a small relay, not peer-to-peer

**Chosen:** devices talk to a relay over WebSocket. The relay stores an append-only log per doc, so a device that comes online later can catch up even when no other device is online.
**Why:**
- Pure P2P (WebRTC) needs both devices online at the same moment, plus a signaling server, and NAT traversal on mobile networks is unreliable.
- **Browsers cannot discover or serve other devices on the LAN** (no mDNS, no listening sockets). Something has to run on a reachable host anyway.
- Shared-folder sync (Syncthing, Dropbox) doesn't work from a mobile browser, and it merges at file granularity.

**LAN-only setups are still fully supported.** Run the relay on any always-on machine on your network, such as a home server, NAS, Raspberry Pi, or desktop. Devices then sync only when they can reach it, which usually means when they are on the same LAN. Nothing ever leaves the network. See [SELF_HOSTING.md](./SELF_HOSTING.md#option-c-lan-only-home-server).

### D4. No accounts: the join link is the key

**Chosen:** a sync session is `(relay URL, 256-bit random secret)`. You add a device by opening a join link of the form `https://<app>/#join?r=<relay>&k=<secret>`.
- The secret is in the URL **fragment**, which browsers never send to any server, including the one serving the app.
- From the secret, devices derive (HKDF-SHA256):
  - `roomId`: the only thing the relay knows about the session (unguessable, not reversible)
  - an AES-256-GCM key, which encrypts every update and snapshot
  - an HMAC key, which turns internal doc names (`index`, `note:<uuid>`) into opaque ids, so the relay can't even count your notes by name
- The relay stores and forwards ciphertext only.

**Why:** this gives "only trusted devices can sync" without building identity, passwords, or account recovery. The relay operator, whether that's you, a friend, or a cloud host, can't read notes.

**Trade-offs, accepted for now:**
- Anyone who obtains the link has full read and write access. Treat it like a password.
- No per-device revocation yet. To remove a device, start a new session and re-add the devices you trust (see §6).
- The relay can't tell your devices from a stranger who guessed nothing but knows a `roomId`. Such a stranger could only append garbage, which devices discard because it fails authenticated decryption. Abuse limits (quotas, rate limits) are the relay operator's job.

### D5. The relay is a blind mailbox

**Chosen:** the relay validates frame shapes and sizes, assigns sequence numbers, stores ciphertext, and broadcasts. It never merges, decrypts, or interprets anything.
**Why:** it's tiny (a few hundred lines), cheap to run, easy to audit, and easy to reimplement on any platform.
**Consequence:** compaction has to be client-driven (see §3, step 7).

### D6. Provider-neutral relay, with a self-hosted server as the reference

**Chosen:** the relay logic (`apps/relay/src/core`) is written against a one-function SQL interface and a minimal `Peer` interface. Two runtimes ship:
- **Self-hosted server** (`src/server`, reference): runs on **Bun** (see D12). It only uses standard modules (`node:http`, `node:sqlite`) and `ws`, so it has no native modules and builds into one self-contained file that also runs unchanged on Node.js 22.13+. It can also serve the built app, so one process covers everything. Docker image included.
- **Cloudflare Workers + Durable Objects** (optional): uses the same core and fits the Workers free plan. It uses the WebSocket Hibernation API and keeps all state in the object's SQLite storage.

**History:** an earlier draft of this design targeted Cloudflare's free tier directly. That was revised so that no part of the project depends on one vendor. Cloudflare became one deployment option among several.
**Considered:** Bun-only APIs such as `bun:sqlite` and `Bun.serve` (faster, but they would tie the server to one runtime; the standard modules keep Node as a fallback), and Postgres or Redis backends (unnecessary for this workload; SQLite is a single file). Others can add runtimes, such as Deno or another edge platform, by implementing `Sql` and `Peer`.

### D7. Installable web app (PWA) first

**Chosen:** one web codebase, installable on desktop and mobile, with a service worker that caches the app shell for instant offline startup.
**Why:** it reaches every device with one codebase, has no app-store dependency, and is easiest for others to self-host (it's just static files).
**Later:** thin native wrappers (Tauri for desktop, Capacitor for mobile) if features need them, such as LAN discovery via mDNS, OS share sheets beyond the Web Share Target API, or background sync on iOS.

### D8. Preact for the UI

**Chosen:** [Preact](https://preactjs.com/).
**Why:** the project's author works in React. Preact has the same component and hooks API at about 4 KB, and `preact/compat` lets React libraries (including editor bindings) work unchanged. UI framework speed isn't the bottleneck in this app; local-first data access is what makes it fast.
**Considered:** Solid (JSX, but a different reactivity model to learn), Svelte (its own templating), and React itself (fine, but about 10× larger). The full app bundle is currently about 35 KB gzipped.

### D9. Data model: one index doc plus one doc per note

**Chosen:**
- `index`: a `Y.Map` of note id → `{ title, createdAt, updatedAt, deleted }`. It's opened and synced at startup.
- `note:<uuid>`: a `Y.Text` body, opened and synced only when the note is opened.

**Why:** startup cost stays flat as the archive grows. Very large notes only cost something when they're opened. Deletion is a tombstone flag, so it syncs like any other edit.
**Future:** archive items (saved links, media) will be new doc kinds listed in the same index (see §7).

### D10. Own IndexedDB persistence instead of `y-indexeddb`

**Chosen:** one IndexedDB record per doc, holding `{ state, seq, pending }`, written in a single put.
**Why:** sync correctness needs the doc state, the last applied relay `seq`, and the not-yet-acknowledged edits to be saved atomically. With separate stores, a crash between writes could skip remote updates or drop local ones.

### D11. HTTPS is required, even on a LAN

Browsers only provide WebCrypto (`crypto.subtle`) and service workers in a **secure context**: `https://` or `http://localhost`. A plain `http://192.168.x.x` page can't encrypt or work offline. The app checks for this at startup and explains it. [SELF_HOSTING.md](./SELF_HOSTING.md) covers ways to get HTTPS on a LAN (a local CA with Caddy, mkcert, or a real domain with a DNS challenge).

### D12. Monorepo on Bun

**Chosen:** [Bun](https://bun.sh) as package manager, script runner, test runner, bundler and server runtime. Bun workspaces (`packages/*`, `apps/*`), TypeScript everywhere, Vite for the app, `bun build` to bundle the relay into one file, `bun test` for tests.
**Why:** one fast tool replaces npm, tsx, esbuild and a separate test runner, which keeps installs and CI quick and the toolchain small. The protocol types are shared, so the app and the relay can't drift apart.
**Portability:** the relay code avoids Bun-only APIs (see D6), so self-hosters who can't install Bun can still run the built relay on Node.js.
**History:** the first scaffold used npm workspaces with Node, tsx and esbuild; it moved to Bun before v0.

### D13. Editor: undecided (textarea placeholder)

The scaffold binds a plain `<textarea>` to `Y.Text` with a prefix/suffix diff, which is enough to prove sync. The real editor choice is still open:
- **CodeMirror 6 + y-codemirror.next**: markdown-first and plain-text storage. Very fast on huge documents, and the lightest option.
- **Tiptap/ProseMirror + y-prosemirror**: rich text, better for embedding archived media, heavier.

---

## 5. Security model

| Party | Can | Cannot |
|---|---|---|
| Your devices (have the link) | read and write everything | n/a |
| Relay operator | see room ids, opaque doc ids, update sizes and timing, IP addresses | read note content or titles, forge updates that devices accept |
| Network observer (with TLS) | see that you talk to the relay | anything else |
| Stranger who knows only the relay URL | open sockets to random rooms | find your room (128-bit id) or decrypt anything |
| Anyone who gets the join link | **everything your devices can do** | n/a |

Not protected against yet: a compromised device, metadata analysis by the relay operator, or rollback by a malicious relay (withholding updates). Updates are authenticated per room and doc (AES-GCM with associated data `roomId/docId`), but there's no global ordering proof.

---

## 6. Operations notes

- **Removing a device:** create a new session on a trusted device and re-join your other devices with the new link. Old-session data on the relay can be deleted by the operator. Built-in key rotation is on the roadmap.
- **Backups:** your devices hold the real copies. The relay's SQLite file holds only ciphertext and is useful as an encrypted off-device backup. It's useless without the join link, so keep the link somewhere safe, such as a password manager.
- **Switching relays:** start a new session pointing at the new relay. Every device re-uploads its local state, and the merge is automatic.

---

## 7. Roadmap and open questions

Near term:
- [ ] Pick the editor (D13) and replace the textarea binding.
- [ ] QR code for the join link (the main way phones will join).
- [ ] Note list search (local, client-side full-text index).
- [ ] Sync status per note, and a visible "unsynced changes" indicator.

Archive features:
- [ ] Web Share Target so the installed PWA appears in the OS share sheet ("save to notes-hq").
- [ ] Archive item types (link, article, video, social post) with metadata, stored as docs in the index.
- [ ] Encrypted blob storage for media and attachments: chunked, content-addressed, and lazily fetched. This needs a protocol extension and a storage backend on the relay.
- [ ] Integrations/import API. Fetching remote pages needs a component that can read content, so it has to run client-side or as an optional self-hosted helper, never on the blind relay.

Hardening:
- [ ] Key rotation and device removal without manual re-joining.
- [ ] Binary WebSocket frames (saves the ~33% base64 overhead).
- [ ] Relay quotas and rate limits per room.
- [ ] Automated browser tests in CI (two-device sync, offline/reconnect).

Open questions:
- Should compaction thresholds adapt to doc size?
- Do we need native wrappers for true LAN discovery, or is "run a relay on the LAN" enough?
