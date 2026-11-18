// Local SQLite schema, applied in order. Append new migrations; never edit shipped ones.
// Tables use an INTEGER `rid` rowid (stable across VACUUM) so FTS rows can key on it.

export const MIGRATIONS: string[][] = [
  [
    `CREATE TABLE notebook (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      sort INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    )`,
    `CREATE TABLE tag (
      id TEXT PRIMARY KEY,
      parent_id TEXT,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    )`,
    `CREATE TABLE note (
      rid INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      notebook_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      snippet TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    )`,
    `CREATE INDEX note_notebook ON note(notebook_id, updated_at)`,
    `CREATE TABLE note_tag (
      note_id TEXT NOT NULL,
      tag_id TEXT NOT NULL,
      PRIMARY KEY (note_id, tag_id)
    )`,
    `CREATE INDEX note_tag_tag ON note_tag(tag_id)`,
    // Yjs updates per note (base64). Compacted into one row periodically; becomes the sync log in 2c.
    `CREATE TABLE note_update (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id TEXT NOT NULL,
      data TEXT NOT NULL
    )`,
    `CREATE INDEX note_update_note ON note_update(note_id, seq)`,
    `CREATE VIRTUAL TABLE note_fts USING fts5(title, body, tokenize = 'unicode61 remove_diacritics 2')`,
    `CREATE TABLE attachment (
      hash TEXT PRIMARY KEY,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      filename TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
  ],
  // 2: sync bookkeeping (see ledger.ts).
  [
    `CREATE TABLE sync_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    // Per-field HLC timestamps for last-writer-wins; pending = changed here and not yet acknowledged by the server.
    `CREATE TABLE field_state (
      kind TEXT NOT NULL,
      id TEXT NOT NULL,
      field TEXT NOT NULL,
      ts TEXT NOT NULL,
      pending INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (kind, id, field)
    )`,
    `CREATE INDEX field_state_pending ON field_state(pending)`,
    // dirty counts local body updates not yet pushed; server_sv is the Yjs state vector the server is known to have.
    `CREATE TABLE body_state (note_id TEXT PRIMARY KEY, dirty INTEGER NOT NULL DEFAULT 0, server_sv TEXT)`,
    // Notes deleted forever, so late changes from other devices don't bring them back.
    `CREATE TABLE purged_note (id TEXT PRIMARY KEY)`,
    // Attachments known from other devices whose files haven't been downloaded yet.
    `CREATE TABLE blob_missing (hash TEXT PRIMARY KEY)`,
  ],
]
