# Sync (milestone 2c)

Decided with the user on 2026-11-18. Builds on [design.md](design.md) and [milestone-2.md](milestone-2.md).

## Decisions

| Area | Decision |
|---|---|
| Phasing | **2c-1:** server, Postgres and sync, with devices joining by one-time code. **2c-2:** passkeys on top, signed in through the system browser, because the Tauri webview's origin isn't the server's domain. Then deploy to the droplet. |
| Local first | Run the server locally (Postgres in Docker) until sync works end to end, then deploy. |
| Joining | The server prints a **setup code** (valid 24 h) while no device is connected; `npm run setup-code -w @tdjr/server` prints a new one. A connected device shows a **device code** (⚙ → Add a device…, valid 10 min, single use). Devices are listed and can be disconnected (⚙ → Devices…). |
| Metadata | Synced **per field, last writer wins**, ordered by a hybrid logical clock (`packages/core/src/hlc.ts`). Fields per record kind are in `SYNC_FIELDS` (`syncProtocol.ts`). Note tags sync as one field (the tag-id list). |
| Note bodies | Yjs updates. A device pushes only the part of each document the server doesn't have yet (diff against the last acknowledged state vector). The server stores updates as-is; compaction comes later. |
| Delete forever | A `purged` field on the note. Every device then deletes the note and remembers it, so a late edit from another device can't bring it back. The server drops that note's body history. |
| Attachments | Content-addressed files (SHA-256), uploaded before their records and downloaded on demand. The server checks every file against its hash. |
| Ordering | One global change sequence on the server. Pushes take a Postgres advisory lock, so changes become visible in sequence order and a device that pulls everything after its cursor never skips one. Each device's own changes are left out of what it pulls. |
| Live updates | A WebSocket that only says "something changed". The client then syncs. A full sync also runs every 5 minutes and after any local change (debounced). |
| Offline | Changes queue in the local ledger (`field_state`, `body_state`) and go out on the next successful sync. The UI shows Offline instead of an error. |
| First connect | If the server already has notes and this device has none, the device's starter data (an empty "Notes" notebook) is dropped. Otherwise everything on the device is uploaded and merges, and values never edited since sync existed are timestamped from their last-modified time, so newer edits elsewhere still win. |

## Pieces

- `packages/core/src/ledger.ts`: local bookkeeping (migration 2). Tracks changed fields and dirty bodies, builds pushes, and applies pulls.
- `packages/core/src/syncClient.ts`: enrollment, the push/pull loop, attachment transfer, the event socket, status and retries.
- `apps/server`: Fastify, Postgres and `ws`. `sync.ts` holds the merge rules, `app.ts` the routes, `auth.ts` the codes and tokens.
- `apps/desktop/src/sync.ts` (`useSync`), `SyncDialogs.tsx` and the ⚙ menu's Sync section.

## Running locally

1. `npm run db:up -w @tdjr/server` starts Postgres in Docker on `127.0.0.1:55432` (5433 is taken by WSL on this machine).
2. `npm run server` starts the sync server on `http://localhost:8787` and prints a setup code.
3. In the app: ⚙ → Connect to server…, then enter the address and the code.

`npm test` runs the end-to-end tests in `apps/server` against a `notes_test` database. They are skipped when Postgres isn't running.

## Not yet

- Passkeys (2c-2). Until then the device token sits in the local database; it moves to the OS keychain with 2c-2.
- Server-side compaction of body updates, the plain-text projection for server search and export, and backups.
- Deployment to the droplet (Caddy for TLS, a systemd or Docker service, nightly dumps).
