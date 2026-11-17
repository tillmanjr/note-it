# Milestone 2 — Desktop + server MVP

Status: 2a in progress (2026-11-17). Builds on [`design.md`](design.md) and the [editor spike](editor-spike.md).

## Decisions

| Area | Decision |
|---|---|
| Server trust | Server can read notes (TLS in transit, disk encryption at rest). Only vault sections are E2E. Server-side search, backups and export are allowed. |
| Desktop shell | **Tauri 2** (WebView2 on Windows). |
| Attachments (server) | Pluggable blob store; disk implementation first (DO Volume + offsite backup), S3/Spaces later via config. |
| Note body format | **Yjs document per note from day one** (TipTap Collaboration extension), even before sync exists, so 2b adds sync without a data migration. |
| Local storage | SQLite on device behind a `Store` interface in shared code. Tauri adapter first; Capacitor adapter for mobile later. FTS5 for search. |
| Layout | Two panes: left pane with collapsible Notebooks / Tags / Notes sections and Trash pinned at the bottom; editor on the right. Search is an overlay (Ctrl+Shift+F). |

## Order (import early)

- **2a — Local desktop app.** Tauri app, local SQLite. Notebooks, hierarchical tags, notes (Yjs bodies),
  note list with sort/filter, full-text search, attachments (content-addressed files), trash.
  Usable daily on one machine, offline.
- **2b — Evernote `.enex` import.** Pick notebooks/files to import; ENML → editor schema; checklists,
  attachments, tags (optional `a/b` → hierarchy), dates. A report of anything that didn't map.
- **2c — Server + sync + auth.** Node/Fastify + Postgres on the droplet; Yjs update sync per note,
  metadata sync, blob upload/download; passkeys → device tokens.
- **2d — Vault-encrypted sections.** As specified in `design.md`.

Mobile (milestone 3) follows 2c.

## Repository layout

```
package.json            npm workspaces
packages/editor         TipTap schema, extensions, toolbars (from the spike)
packages/core           data model types, ids, tag-tree logic, Store interface, ENML import
apps/desktop            Vite + React UI and Tauri shell (src-tauri)
apps/server             (2c)
apps/mobile             (milestone 3)
spike/editor            frozen reference
```

## Data model (local; the server mirrors it)

- `notebook(id, name, sort, created_at, updated_at, deleted_at)`
- `tag(id, parent_id, name, created_at, updated_at, deleted_at)` — tree; a full path is derived.
- `note(id, notebook_id, title, created_at, updated_at, deleted_at)`
- `note_tag(note_id, tag_id)`
- `note_body(note_id, ydoc_state)` + `note_update(note_id, seq, update)` — append updates, compact periodically.
- `note_text` — FTS5 table (title + plain-text projection; vault sections excluded).
- `attachment(hash, mime, size, filename, created_at)`; file at `<appdata>/blobs/<sha256>`.
  Notes reference attachments by hash (`attachment:<sha256>`), resolved to a local URL at render time.
- IDs are ULIDs (sortable, generated offline). Timestamps are UTC ms. Deletion is a soft `deleted_at` (trash).

## Success criteria for 2a

- Create, organize, find and edit notes entirely offline in the Tauri app, with everything the spike can do.
- Data survives restarts; search over a few thousand notes returns in < 100 ms.
- Pasted and dropped images are stored as local attachment files, not data URLs.

## Progress

**2a (first cut, 2026-11-17)** — run with `npm install` then `npm run desktop` from the repo root.
Data lives in `%APPDATA%\com.tdjr.notes` (`notes.db`, `blobs/`).

- Two-pane UI: left pane with collapsible Notebooks (incl. All notes), Tags (tree: create, sub-tag,
  rename, delete) and Notes sections (collapse state remembered), Trash pinned at the bottom
  (restore / delete forever, read-only view).
- Search overlay (Ctrl+Shift+F): ranked results (title matches weigh more) with highlighted
  excerpts, optional scope to the current notebook/tag, keyboard navigation. Opening a result
  doesn't change what the left pane is browsing.
- Notes: title, notebook, tags (type `a/b/c` to create nested tags), Yjs-backed body with the full
  editor (toolbar + right-click format bar). Opening a note doesn't change "last edited".
- Search is FTS5 (prefix per word, accent-insensitive); notes sort by edited/created/title.
- Pasted/dropped images stored as content-addressed files, referenced as `attachment:<sha256>`.
- `npm run dev -w @tdjr/desktop` serves the same UI in a browser (SQLite WASM, localStorage) for
  UI development and automated testing.

Not yet: non-image attachments (PDF/files), downloading remote images on paste, dragging tags to
re-parent, drag notes between notebooks, saved searches, note history.
