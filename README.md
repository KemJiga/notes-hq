# notes-hq

Local-first notes that sync across **your own devices** (PC, laptop, phone, tablet) through a tiny relay **you host**. Notes are end-to-end encrypted, so the relay can't read them, and there are no accounts: adding a device means opening a link.

The long-term goal is a personal archive: notes plus things you save from the web (articles, videos, posts), all in one place you control.

> **Status:** early scaffold. Sync and the rich text editor work end to end. Archive features aren't built yet. See the [roadmap](docs/DESIGN.md#7-roadmap-and-open-questions).

## How it works

- **Local-first.** Every device keeps a full copy of its notes in the browser (IndexedDB) and works offline. Nothing waits on the network.
- **Conflict-free merging.** Notes are [Yjs](https://github.com/yjs/yjs) CRDT documents, so edits made on different devices, even offline, merge automatically.
- **Blind relay.** Devices exchange encrypted updates through a small WebSocket relay that stores ciphertext and forwards it. Run it on a home server for LAN-only sync, on a VPS, in a container, or on an edge platform.
- **Link = key.** A sync session is a relay URL plus a random secret carried in a join link's `#fragment`. Every device that opens the link shares the encryption key; nobody else does.

Read [docs/DESIGN.md](docs/DESIGN.md) for the full reasoning.

## Quick start

Run the app and the relay together with the prebuilt Docker image:

```sh
docker run -d --name notes-hq -p 8787:8787 -v notes-hq-data:/data ghcr.io/kemjiga/notes-hq:latest
```

Open <http://localhost:8787>, write a note, then click **Local only** → **Start a new sync session**. Open the join link it shows on your other devices to sync them.

No Docker? Download `notes-hq-<version>.tar.gz` from [Releases](https://github.com/KemJiga/notes-hq/releases), extract it, and run:

```sh
cd notes-hq-<version>
STATIC_DIR=web bun relay.js     # or: STATIC_DIR=web node relay.js  (Node.js 22.13+)
```

Other devices can only connect over **HTTPS** (browsers require it for encryption and offline support, even on a LAN). Put a reverse proxy in front of port 8787; [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md#getting-https) shows how.

## Releases

Releases are listed on the [Releases page](https://github.com/KemJiga/notes-hq/releases). Each one ships:

- `notes-hq-<version>.tar.gz`: the relay as a single file (`relay.js`, runs on Bun or Node.js 22.13+) plus the built app (`web/`). No `node_modules` needed.
- A Docker image: `ghcr.io/kemjiga/notes-hq:<version>`, `:<major>.<minor>`, and `:latest` for the newest stable release.

Versions follow [semver](https://semver.org). Until 1.0, a minor version (0.x → 0.y) may include breaking changes; the release notes call them out. To upgrade, replace the files or pull the new image and restart; your data lives in `DATA_DIR` (the `/data` volume in Docker) and on your devices.

To cut a release, push a version tag: `git tag v0.2.0 && git push origin v0.2.0`. The [release workflow](.github/workflows/release.yml) builds, publishes both artifacts, and writes release notes from the merged PRs. Tags with a suffix (`v0.2.0-rc.1`) become prereleases.

## Development

Requires [Bun](https://bun.sh) 1.4+.

```sh
bun install
bun run dev
```

This starts the relay on `:8787` and the app on Vite's dev server (`:5173`). Open the app, click **Local only**, and choose **Start a new sync session** (the relay `ws://localhost:8787` is pre-filled). Then open the join link in another browser profile to watch two "devices" sync.

Other scripts: `bun run build`, `bun run typecheck`, `bun run test`.

## Self-hosting from source

One command, one process, app and relay together:

```sh
bun install --frozen-lockfile && bun run build
cd apps/relay && STATIC_DIR=../web/dist bun run start
```

Or use Docker: `docker compose up -d`.

Browsers require **HTTPS** for this app (except on `localhost`), including on a LAN. [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md) covers single-process, Docker, LAN-only home servers, split static-host + relay setups, an optional Cloudflare Workers adapter, and HTTPS.

## Deploying to Cloudflare

No server to run: the relay goes on **Workers** (with SQLite-backed Durable Objects) and the app on **Pages**. Both work on the free plan and come with HTTPS. You need a Cloudflare account and the steps below, run from the repo root after `bun install`.

**1. Log in.**

```sh
cd apps/relay
bunx wrangler login
```

**2. Deploy the relay.**

```sh
bunx wrangler deploy
```

Wrangler prints the relay's address, e.g. `https://notes-hq-relay.<your-subdomain>.workers.dev`. Check it with `curl https://notes-hq-relay.<your-subdomain>.workers.dev/healthz` (prints `ok`).

**3. Build the app pointed at the relay.** Use the address from step 2 with `wss://`:

```sh
cd ../..
VITE_RELAY_URL=wss://notes-hq-relay.<your-subdomain>.workers.dev bun run --filter '@notes-hq/web' build
```

**4. Deploy the app to Pages.**

```sh
bunx wrangler pages project create notes-hq --production-branch main   # first time only
bunx wrangler pages deploy apps/web/dist --project-name notes-hq
```

The app is now at `https://notes-hq.pages.dev` (or the name Pages assigns if that one is taken).

**5. Lock the relay to your app.** In [apps/relay/wrangler.toml](apps/relay/wrangler.toml), set the app's origin, then redeploy the relay:

```toml
[vars]
ALLOWED_ORIGINS = "https://notes-hq.pages.dev"
```

```sh
cd apps/relay && bunx wrangler deploy
```

Open the Pages URL, write a note, and click **Local only** → **Start a new sync session**; the relay is pre-filled. Open the join link on your other devices.

To update later, `git pull`, then repeat steps 2–4. Using your own domain? Add it under *Workers & Pages → your project → Custom domains*, rebuild the app if the relay address changed, and add the new origin to `ALLOWED_ORIGINS` (comma-separated). Free-plan limits apply; if a daily limit is hit, devices keep working offline and sync again after the reset. More in [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md#option-e-cloudflare-workers-optional).

### Deploy from GitHub Actions

Once steps 1–4 have run once (so the Worker and Pages project exist), [deploy-cloudflare.yml](.github/workflows/deploy-cloudflare.yml) can redeploy both on every version tag, or on demand from the *Actions* tab. In your fork's *Settings → Secrets and variables → Actions*, add:

| Kind | Name | Value |
|---|---|---|
| Secret | `CLOUDFLARE_API_TOKEN` | A [custom API token](https://dash.cloudflare.com/profile/api-tokens) with *Account → Workers Scripts: Edit* and *Account → Cloudflare Pages: Edit* |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | Your account ID (dashboard → *Workers & Pages*, right sidebar) |
| Variable | `CF_RELAY_URL` | `wss://notes-hq-relay.<your-subdomain>.workers.dev` |
| Variable | `CF_ALLOWED_ORIGINS` | `https://notes-hq.pages.dev` (comma-separated if several) |
| Variable | `CF_PAGES_PROJECT` | Optional, defaults to `notes-hq` |

The workflow sets `ALLOWED_ORIGINS` from the variable, so `wrangler.toml` can stay unedited. It is skipped when `CF_RELAY_URL` isn't set.

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
