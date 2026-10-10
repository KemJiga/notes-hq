# Self-hosting notes-hq

notes-hq has two parts:

- **The app:** static files (HTML, JS, CSS) produced by `npm run build`. Any static web server can host them.
- **The relay:** a small WebSocket service that stores and forwards **encrypted** updates between your devices. It never sees your notes.

You can run both from one process (simplest) or host them separately. Nothing here depends on a particular provider, operating system, or device.

> **Requirement: HTTPS.** Browsers only allow the encryption and offline features this app needs on `https://` pages (or `http://localhost`). Every setup below ends with HTTPS in front of the app and relay. See [Getting HTTPS](#getting-https).

Contents:
- [Option A: one Node process](#option-a-one-node-process)
- [Option B: Docker](#option-b-docker)
- [Option C: LAN-only home server](#option-c-lan-only-home-server)
- [Option D: app and relay hosted separately](#option-d-app-and-relay-hosted-separately)
- [Option E: Cloudflare Workers (optional)](#option-e-cloudflare-workers-optional)
- [Configuration reference](#configuration-reference)
- [Getting HTTPS](#getting-https)
- [Backups, upgrades, and moving](#backups-upgrades-and-moving)

---

## Option A: one Node process

Requirements: Node.js **22.13 or newer**. The relay uses Node's built-in SQLite, so there are no native modules to compile.

```sh
git clone https://github.com/KemJiga/notes-hq.git
cd notes-hq
npm ci
npm run build

# Serve the app and the relay together on port 8787
cd apps/relay
STATIC_DIR=../web/dist DATA_DIR=./data npm start
```

Open `http://localhost:8787` on the same machine to try it. To reach it from other devices, put a reverse proxy with HTTPS in front of it (see [Getting HTTPS](#getting-https)).

When the app and relay share an origin, the app already knows where the relay is, so you don't need any extra configuration.

To keep it running, use whatever your system offers. Here's a systemd example:

```ini
# /etc/systemd/system/notes-hq.service
[Unit]
Description=notes-hq
After=network.target

[Service]
WorkingDirectory=/opt/notes-hq/apps/relay
Environment=STATIC_DIR=/opt/notes-hq/apps/web/dist
Environment=DATA_DIR=/var/lib/notes-hq
Environment=HOST=127.0.0.1
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning dist/relay.mjs
Restart=on-failure
User=notes-hq

[Install]
WantedBy=multi-user.target
```

## Option B: Docker

The included `Dockerfile` builds one small image that serves the app and the relay.

```sh
docker build -t notes-hq .
docker run -d --name notes-hq -p 8787:8787 -v notes-hq-data:/data --restart unless-stopped notes-hq
```

Or use `docker compose up -d` with the included `docker-compose.yml`. It works the same with Podman or any OCI-compatible runtime, and on any container platform (Fly.io, Railway, Render, Kubernetes, a NAS with container support, and so on). Mount a persistent volume at `/data`.

## Option C: LAN-only home server

If you want your notes to **never leave your network**, run Option A or B on any always-on machine at home, such as a mini PC, a NAS, a Raspberry Pi, or a desktop that stays on. Devices sync whenever they can reach that machine, which usually means when they're on the home network. Away from home, they keep working offline and catch up when they're back.

This is the only setup where nothing touches the internet. The app is installed from your server, and sync happens over your LAN.

The one complication is HTTPS. Pick one:

1. **Your own domain, with a private IP (recommended, no setup on devices).** Point a DNS record such as `notes.example.com` at the server's LAN IP (`192.168.1.20`). Then get a real certificate with a **DNS-01 challenge**, which works without exposing the server to the internet. Caddy (with a DNS provider plugin), Traefik, certbot, and acme.sh all support this. Every device trusts the certificate out of the box.
2. **A local certificate authority.** Run Caddy with `tls internal` (example below) or create certificates with [mkcert](https://github.com/FiloSottile/mkcert). Then install the CA's root certificate on each device. On desktops this is usually a double-click. On iOS, install the profile and then enable it under *Settings → General → About → Certificate Trust Settings*. On Android, install it as a CA certificate under the security settings. Menu paths vary by version.
3. **A mesh VPN that issues certificates.** Some VPNs provide HTTPS names for your machines. This works too, but it brings in a third party.

Caddy with a local CA:

```caddyfile
notes.home.arpa {
    tls internal
    reverse_proxy 127.0.0.1:8787
}
```

(`notes.home.arpa` must resolve to the server on your LAN, through your router's DNS or a hosts entry.)

## Option D: app and relay hosted separately

Use this when you want the app on a static host (any CDN, GitHub Pages, Netlify, an S3 bucket, nginx, and so on) and the relay somewhere else.

1. Build the app, optionally pre-filling the relay address users will see:
   ```sh
   VITE_RELAY_URL=wss://relay.example.com npm run build --workspace @notes-hq/web
   ```
   Upload `apps/web/dist/` to your static host. Configure it to serve `index.html` for unknown paths (SPA fallback) and **not to cache** `sw.js` and `index.html`. Files under `assets/` can be cached forever.
2. Run the relay (Option A without `STATIC_DIR`, or Option B), behind HTTPS.
3. Restrict which sites may connect:
   ```sh
   ALLOWED_ORIGINS=https://notes.example.com
   ```

Users can also type any relay URL when they start a sync session, so one hosted copy of the app can be used with many different relays.

## Option E: Cloudflare Workers (optional)

An adapter in `apps/relay/src/cloudflare` runs the same relay core on Workers with SQLite-backed Durable Objects, which are available on the free plan. Only the relay runs there; host the app with any static host (Option D).

```sh
cd apps/relay
npx wrangler login
npx wrangler deploy           # uses wrangler.toml
```

Set `ALLOWED_ORIGINS` under `[vars]` in `wrangler.toml`. Free-plan limits apply. If a daily limit is reached, devices keep working offline and sync again after the reset.

Want to add another runtime, such as Deno or another edge platform? Implement the `Sql` function and `Peer` interface from `apps/relay/src/core`, following the two existing adapters.

---

## Configuration reference

Relay (Node), set as environment variables:

| Variable | Default | Description |
|---|---|---|
| `HOST` | `0.0.0.0` | Interface to listen on. Use `127.0.0.1` behind a reverse proxy. |
| `PORT` | `8787` | Port. |
| `DATA_DIR` | `./data` | Directory for `relay.sqlite`. |
| `STATIC_DIR` | *(unset)* | If set, also serve the built app from this directory. |
| `ALLOWED_ORIGINS` | *(any)* | Comma-separated origins allowed to open sync sockets. |
| `MAX_DATA_BYTES` | `1048576` | Max size of one encrypted update or snapshot. Raise it if you keep very large notes. |
| `MAX_SUBS_PER_PEER` | `10000` | Max docs one connection may subscribe to. |

App, set at build time:

| Variable | Default | Description |
|---|---|---|
| `VITE_RELAY_URL` | same origin as the app | Relay pre-filled in the "Start a new sync session" form. |

Endpoints: `GET /healthz` (health check) and `GET /v1/rooms/<roomId>` (WebSocket upgrade).

## Getting HTTPS

Any TLS-terminating reverse proxy works. It must pass WebSocket upgrades through.

**Caddy** (automatic certificates for public domains):

```caddyfile
notes.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

**nginx:**

```nginx
server {
    listen 443 ssl;
    server_name notes.example.com;
    # ssl_certificate / ssl_certificate_key ...

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 1h;
    }
}
```

For LAN-only servers, see [Option C](#option-c-lan-only-home-server).

## Backups, upgrades, and moving

- **What to back up:** your devices hold the real data. The relay's `DATA_DIR/relay.sqlite` contains only ciphertext. It's a useful encrypted off-site copy, but it can't be read without a join link. Keep a join link somewhere safe, such as a password manager. That's the only thing needed to decrypt.
- **Upgrading:** pull, `npm ci && npm run build`, and restart (or rebuild the image). The relay creates its tables if they're missing.
- **Moving to a new relay:** on one device, open Sync, stop syncing, and start a new session with the new relay URL. Then re-join your other devices with the new link. Each device uploads its local notes, and they merge automatically.
- **Removing a device you lost:** do the same thing. Start a new session and only re-join the devices you still trust. The old link stops being useful once the old relay data is deleted.
