# Sync (milestone 2c)

Decided with the user on 2026-11-18. Builds on [design.md](design.md) and [milestone-2.md](milestone-2.md).

## Decisions

| Area | Decision |
|---|---|
| Phasing | **2c-1:** server, Postgres and sync, with devices joining by one-time code. **2c-2:** per-device passkeys with admin approval (done; see [passkeys.md](passkeys.md)). Then deploy to the droplet. |
| Local first | Run the server locally (Postgres in Docker) until sync works end to end, then deploy. |
| Joining | Since 2c-2: a device requests access with its own passkey, an admin approves it from the server's shell (`notes-admin`), and the device signs in with Windows Hello once per launch. Details in [passkeys.md](passkeys.md). |
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
- `packages/core/src/syncClient.ts`: requesting access and signing in, the push/pull loop, attachment transfer, the event socket, status and retries.
- `apps/server`: Fastify, Postgres and `ws`. `sync.ts` holds the merge rules, `app.ts` the routes, `passkey.ts` access requests, passkeys and sessions, `admin.ts` the admin CLI.
- `apps/desktop/src/sync.ts` (`useSync`), `SyncDialogs.tsx` and the ⚙ menu's Sync section.

## Applying a pull quickly (2026-11-22)

The tablet's first sync was slow, about 120 database calls a second. Every call crosses from the web view to Android, every write was its own commit to disk, and each pulled change took about six calls. Now each pulled page (up to 1000 changes) is applied with a few bulk reads up front and its writes in one batch (`SqlDriver.batch`, one transaction).

- The tablet's driver sends a batch to Android in one call (`executeSet`), and the browser's runs it in a transaction. Tauri doesn't batch: its SQL plugin spreads statements over a connection pool, where a transaction can't be relied on, and the desktop is fast enough without it.
- Measured in the e2e test, a first sync of 300 notes takes 6,056 database calls one at a time and 30 in batches, with the same result. The test checks both paths.
- A page applied in a batch is all or nothing, so an interrupted first sync never leaves half a page behind.

## Running locally

1. `npm run db:up -w @tdjr/server` starts Postgres in Docker on `127.0.0.1:5320` (this project's ports: 5318 desktop dev, 5319 sync server, 5320 Postgres).
2. `npm run server` starts the sync server on `http://localhost:5319`.
3. In the app: ⚙ → Request access…, enter the address, and confirm with Windows Hello. The app shows a match code.
4. `npm run admin -w @tdjr/server -- pending` lists requests; `… -- approve <CODE>` approves the one with that code. The app then signs in (one more Windows Hello prompt).

`npm test` runs the end-to-end tests in `apps/server` against a `notes_test` database. They are skipped when Postgres isn't running.

## Not yet

- Server-side compaction of body updates, the plain-text projection for server search and export, and backups.
- Deployment to the droplet (Caddy for TLS, a systemd or Docker service, nightly dumps).
