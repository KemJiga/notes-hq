# notes-hq

Local-first notes that sync across **your own devices** (PC, laptop, phone, tablet) through a tiny relay **you host**. Notes are end-to-end encrypted, so the relay can't read them, and there are no accounts: adding a device means opening a link.

The long-term goal is a personal archive: notes plus things you save from the web (articles, videos, posts), all in one place you control.

> **Status:** early scaffold. Sync works end to end. The editor is a placeholder textarea, and archive features aren't built yet. See the [roadmap](docs/DESIGN.md#7-roadmap-and-open-questions).

## How it works

- **Local-first.** Every device keeps a full copy of its notes in the browser (IndexedDB) and works offline. Nothing waits on the network.
- **Conflict-free merging.** Notes are [Yjs](https://github.com/yjs/yjs) CRDT documents, so edits made on different devices, even offline, merge automatically.
- **Blind relay.** Devices exchange encrypted updates through a small WebSocket relay that stores ciphertext and forwards it. Run it on a home server for LAN-only sync, on a VPS, in a container, or on an edge platform.
- **Link = key.** A sync session is a relay URL plus a random secret carried in a join link's `#fragment`. Every device that opens the link shares the encryption key; nobody else does.

Read [docs/DESIGN.md](docs/DESIGN.md) for the full reasoning.

## Quick start (development)

Requires [Bun](https://bun.sh) 1.4+.

```sh
bun install
bun run dev
```

This starts the relay on `:8787` and the app on Vite's dev server (`:5173`). Open the app, click **Local only**, and choose **Start a new sync session** (the relay `ws://localhost:8787` is pre-filled). Then open the join link in another browser profile to watch two "devices" sync.

Other scripts: `bun run build`, `bun run typecheck`, `bun run test`.

## Self-hosting

One command, one process, app and relay together:

```sh
bun install --frozen-lockfile && bun run build
cd apps/relay && STATIC_DIR=../web/dist bun run start
```

Or use Docker: `docker compose up -d`.

Browsers require **HTTPS** for this app (except on `localhost`), including on a LAN. [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md) covers single-process, Docker, LAN-only home servers, split static-host + relay setups, an optional Cloudflare Workers adapter, and HTTPS.

## Repository layout

```
packages/protocol   shared wire types + validation
apps/web            installable web app (Vite + Preact + Yjs)
apps/relay          relay: runtime-agnostic core + self-hosted server (Bun) + optional Cloudflare runtime
docs/               DESIGN.md · PROTOCOL.md · SELF_HOSTING.md
```

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
