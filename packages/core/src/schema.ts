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
]
