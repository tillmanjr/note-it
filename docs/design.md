# tdjr-info-service — Design Note

Status: draft, 2026-11-16. A personal, single-user replacement for Evernote.

## Purpose

Replace Evernote (now ~$250/yr) with a self-hosted notes service for one user. Keep what makes
Evernote good: real rich-text formatting (true indents, nested lists, tables, inline styles; **not**
Markdown). Drop the general-purpose and multi-user features.

## Decisions

| Area | Decision |
|---|---|
| Clients | Desktop (Windows) + phone (iOS **and** Android), synced |
| Mobile shell | Capacitor wrapping the shared web editor. iOS requires a $99/yr Apple Developer account |
| Desktop shell | Tauri (fallback: Electron) wrapping the same editor |
| Offline | **Must edit offline** on all devices. Full local copy per device; merges without data loss |
| Server | DigitalOcean droplet |
| Stack | TypeScript end to end |
| Main auth | Passkeys (WebAuthn) per device → long-lived, revocable device tokens |
| Encrypted sections | Client-side encrypted blocks within a note, one **vault passphrase** |
| Migration | Selective `.enex` import (chosen notebooks); the rest stays archived as exports |
| First milestone | Desktop client + server, to vet functionality. Mobile is what makes it useful day to day, so it follows immediately |

## Features (MVP)

- **Rich-text notes**: structured document model (ProseMirror/TipTap), not Markdown/HTML strings.
  Real indentation, nested lists, tables, headings, inline styles, links, code, horizontal rules.
- **Notebooks**: purely organizational; a note belongs to exactly one notebook.
- **Hierarchical tags**: a tag tree (e.g. `projects/house/kitchen`), independent of notebooks. Filtering by
  a parent tag includes its descendants.
- **Checklists**: inline task-list items, nestable.
- **Attachments & images**: embedded images, PDFs, arbitrary files; stored as content-addressed blobs.
- **Paste fidelity** (this replaces the web clipper): pasting from browsers keeps structure (tables, lists,
  images, links) via a sanitizing HTML→schema transform. Remote images are downloaded and stored as
  attachments, so notes don't depend on external URLs.
- **Search**: full-text search over titles and bodies, offline on each device, with filters for notebook,
  tag subtree and has-checklist/unchecked items.
- **Encrypted sections**: see below.

Nice to have later: due dates/reminders, OCR in images/PDFs, saved searches, note history UI.

## Architecture

```
 ┌──────────── Client (shared TS/React core) ────────────┐
 │ TipTap editor ↔ Yjs doc per note                       │
 │ Local store: SQLite (Tauri / Capacitor SQLite)         │
 │   - Yjs updates, metadata, FTS index, blob cache       │
 │ Sync engine (WebSocket, y-protocols)                   │
 └───────────────────────┬────────────────────────────────┘
                         │ TLS, device token
 ┌───────────────────────▼──────── DO droplet ────────────┐
 │ Node (Fastify) API + y-websocket-compatible sync       │
 │ Postgres: notes, notebooks, tag tree, Yjs updates      │
 │ Blob store: DO Spaces (or local disk + backups)        │
 │ Caddy for TLS                                          │
 └────────────────────────────────────────────────────────┘
```

- **One Yjs document per note** holds the rich-text body. CRDT merging lets offline edits on two devices
  merge without loss.
- **Metadata** (title, notebook, tags, timestamps, trash) is synced as separate records. A per-field
  last-writer-wins approach is acceptable for one user.
- **Server** stores Yjs updates and compacts them periodically. It also keeps a rendered plaintext/HTML
  projection for server-side search and export (encrypted blocks are excluded).
- **Backups**: nightly Postgres dump + blob sync to separate storage, plus an exportable
  archive (HTML + JSON + attachments) so the data never depends on this app.

## Encrypted sections

- The user selects content and chooses "Encrypt selection". The selection's document fragment is serialized
  and encrypted on the client with **AES-256-GCM**. The key comes from the vault passphrase via **Argon2id**
  (per-vault salt; parameters stored with the vault metadata).
- Stored as a single atomic `encryptedBlock` node in the note: `{ v, alg, kdfRef, iv, ciphertext }`.
  The server, sync, backups and search only ever see ciphertext.
- "Show protected content" prompts for the vault passphrase and decrypts **in memory only**. The block
  re-locks after a configurable timeout (default 3 minutes), on leaving the note, or when the app goes to
  the background. Plaintext is never persisted or indexed.
- Editing a revealed block re-encrypts it as a whole (a new IV each time) when it re-locks or is saved.
- A **verifier** (encrypted known value) lets the client tell the user the passphrase is wrong without
  trying every block.
- Accepted trade-offs: encrypted content isn't searchable; **a lost passphrase means unrecoverable
  content** (no escrow, by design). Passphrase change = re-encrypt all blocks client-side.

## Authentication

- Single user. Each device enrolls with a **passkey** (Windows Hello / Face ID / fingerprint).
- After the WebAuthn login succeeds, the server issues a long-lived **device token** (stored in the OS keychain/keystore),
  listed and revocable per device.
- First-device bootstrap: one-time setup code printed by the server on first run.
- Vault passphrase is entirely separate and never sent to the server.

## Evernote import

- Parse `.enex` (ENML XML): map ENML formatting → TipTap schema, `en-todo` → checklist items,
  `en-media` → attachments (by MD5 hash), notebook from export file, tags → tag tree (with an option to
  split names like `a/b` into hierarchy).
- Evernote-encrypted text (`en-crypt`) is imported as an opaque block flagged "needs re-encryption".
  If feasible, it can be decrypted at import time with the old passphrase and re-encrypted with the vault.

## Milestones

Progress: milestone 1 spike lives in `spike/editor`; see [`editor-spike.md`](editor-spike.md).

1. **Editor spike**: TipTap with the indentation, nesting, checklist, table and paste-from-web behavior.
   Confirm it feels at least as good as Evernote.
2. **Desktop + server MVP**: notebooks, tag tree, attachments, search, Yjs sync, passkey auth, encrypted
   blocks, `.enex` import. Daily use on desktop.
3. **Mobile**: Capacitor app (Android first for free sideloading, then iOS), share-sheet capture, offline.
4. Hardening: backups, export, note history, compaction.

## Success criteria

- Formatting (indents, nested lists, tables) is at least as good as Evernote and survives sync round-trips.
- Offline edits on phone and desktop merge with no data loss.
- Imported notebooks look right.
- Running cost ≲ $10/mo droplet + $99/yr Apple dev account (well under $250/yr).

## Open questions

- Should the whole note store be end-to-end encrypted (not just vault sections)? It would break server-side search
  and projections; search would become client-only.
- Desktop shell: Tauri (smaller, Rust toolchain) vs Electron (simpler, heavier).
- DO Spaces vs droplet disk for attachments.
