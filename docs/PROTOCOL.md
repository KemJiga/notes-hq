# notes-hq sync protocol (v1)

This is the contract between devices and a relay. If you implement a relay on another platform, or a client in another language, this document plus `packages/protocol/src/index.ts` is all you need.

## 1. Session and identifiers

A sync session is a relay URL plus a 32-byte random **secret**, encoded as base64url without padding.

Join link format (the secret stays in the fragment and is never sent to a server):

```
<app-url>#join?r=<urlencoded relay url>&k=<base64url secret>
```

Keys are derived with HKDF-SHA256, using `salt = "notes-hq/v1"` (UTF-8) and these `info` strings:

| info | length | use |
|---|---|---|
| `room-id` | 16 bytes | `roomId` = base64url(output), 22 chars |
| `enc-key` | 32 bytes | AES-256-GCM key |
| `mac-key` | 32 bytes | HMAC-SHA256 key for doc ids |

**Doc ids.** `docId = base64url(HMAC-SHA256(mac-key, docName)[0..16])`. Doc names are internal to clients, for example `index` and `note:<uuid>`.

**Payloads.** `data = base64url(iv[12] ‖ AES-GCM(enc-key, iv, plaintext, aad = "<roomId>/<docId>"))`. The plaintext is a Yjs update (or a full state update, for snapshots).

Relays must accept ids that match `^[A-Za-z0-9_-]{16,64}$` and must treat them as opaque.

## 2. Transport

- WebSocket at `<relay>/v1/rooms/<roomId>`.
- Text frames containing one JSON object each. Binary frames are rejected in v1.
- The relay may check the `Origin` header against an allow-list.
- `GET /healthz` returns `200 ok`.

## 3. Messages

### Client → relay

| `t` | fields | meaning |
|---|---|---|
| `sub` | `doc`, `since` | Subscribe to `doc`. `since` is the highest seq already applied (0 if none). |
| `unsub` | `doc` | Stop receiving live updates for `doc`. |
| `push` | `doc`, `ref`, `data` | Append an encrypted update. `ref` is an opaque string (≤64 chars) echoed in the `ack`. |
| `compact` | `doc`, `upTo`, `data` | Replace all entries with `seq ≤ upTo` with this encrypted snapshot. |

### Relay → client

| `t` | fields | meaning |
|---|---|---|
| `snap` | `doc`, `seq`, `data` | Snapshot covering everything up to `seq`. Sent before `upd` entries during catch-up, only if `since < seq`. |
| `upd` | `doc`, `seq`, `data` | One log entry (during catch-up or live). |
| `synced` | `doc`, `seq` | Catch-up for `doc` is finished. `seq` is the current head. |
| `ack` | `doc`, `ref`, `seq` | Your `push` with `ref` was stored as `seq`. |
| `err` | `code`, `msg` | `bad_message`, `too_large`, `bad_compact`, or `unavailable`. |

## 4. Relay rules

1. `seq` is per (room, doc). It starts at 1 and increases by 1 with each accepted `push`.
2. On `sub`: send `snap` (if one exists and `since < snap.seq`), then every `upd` with `seq > max(since, snap.seq)` in order, then `synced`.
3. On `push`: store the entry, send `ack` to the sender, and send `upd` to **every other** connection subscribed to that doc. The sender does not receive its own update.
4. **Ordering guarantee:** on each connection, messages are sent in the order the entries were stored. Clients rely on this: when a client receives `ack(seq = N)`, it has already received every entry below N.
5. On `compact`: reject with `bad_compact` if `upTo < 1`, `upTo > head`, or `upTo` is not newer than the existing snapshot. Otherwise, delete entries `≤ upTo` and store the snapshot at `seq = upTo`.
6. Enforce size limits on `data` (1 MiB by default) and reply `too_large` when exceeded.
7. Never inspect, decrypt, or transform `data`.

## 5. Client rules

1. Persist `seq` together with the doc state and the unacknowledged local updates, atomically.
2. Push only after `synced` for that doc, keep at most one push in flight per doc, and resend unacknowledged updates after reconnecting.
3. Apply incoming `snap`/`upd` in arrival order. Silently drop payloads that fail decryption.
4. Advance `seq` to the maximum of the current value and any received `snap`, `upd`, or `ack` seq.
5. Upload a snapshot (`compact` with `upTo = seq`) when catch-up replayed many entries. The reference client does this at 100 or more entries.
6. When switching to a different session, reset every doc's `seq` to 0 and queue the full local state for upload.

## 6. Versioning

The version is part of the URL path (`/v1/`). Breaking changes get a new path, and relays may serve several versions side by side.
