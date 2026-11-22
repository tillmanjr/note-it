import { ulid } from 'ulid'
import * as Y from 'yjs'
import { bodyText, snippetOf } from './bodyText'
import { fromBase64, toBase64 } from './encoding'
import { Hlc } from './hlc'
import type { BlobStore, SqlDriver, SqlStatement } from './store'
import { SYNC_FIELDS, type BodyUpdate, type RecordChange, type RecordKind } from './syncProtocol'

// Sync bookkeeping in the local database (migration 2).
//
// Every local metadata change stamps the changed fields with a new HLC timestamp and marks them pending; values
// are read from the real tables at push time, so nothing is stored twice. Note bodies only keep a dirty counter
// and the Yjs state vector the server is known to have, so a push sends just the missing part of the document.
// Remote changes apply when their timestamp is newer than the local one (last writer wins, per field).

const TABLE: Record<RecordKind, { table: string; key: string }> = {
  notebook: { table: 'notebook', key: 'id' },
  tag: { table: 'tag', key: 'id' },
  note: { table: 'note', key: 'id' },
  attachment: { table: 'attachment', key: 'hash' },
  vault_key: { table: 'vault_key', key: 'id' },
}

/** Placeholder rows for records first seen through one field; the remaining fields arrive in the same pull. */
const PLACEHOLDER: Record<RecordKind, string> = {
  notebook: `INSERT OR IGNORE INTO notebook (id, name, sort, created_at, updated_at) VALUES (?, '', 0, 0, 0)`,
  tag: `INSERT OR IGNORE INTO tag (id, parent_id, name, created_at, updated_at) VALUES (?, NULL, '', 0, 0)`,
  note: `INSERT OR IGNORE INTO note (id, notebook_id, title, created_at, updated_at) VALUES (?, '', '', 0, 0)`,
  attachment: `INSERT OR IGNORE INTO attachment (hash, mime, size, filename, created_at) VALUES (?, 'application/octet-stream', 0, '', 0)`,
  vault_key: `INSERT OR IGNORE INTO vault_key (id, wrap, created_at) VALUES (?, '', 0)`,
}

/** Ids per `IN (…)` query, under SQLite's limit of 999 bound parameters. */
const IDS_PER_QUERY = 500
/** SQLite allows at most 999 bound parameters per statement. */
const ROWS_PER_INSERT = 200
/** An empty Yjs update: nothing to send. */
const isEmptyUpdate = (u: Uint8Array) => u.length <= 2 && u.every((b) => b === 0)

export interface PendingBody extends BodyUpdate {
  /** The dirty count this push covers (edits made meanwhile stay dirty). */
  dirty: number
  /** State vector of the document as pushed, base64. */
  sv: string
}

export interface RemoteResult {
  metadata: boolean
  purged: string[]
  /** Raw updates per note, for applying to an open editor. */
  bodies: Map<string, Uint8Array[]>
}

export class SyncLedger {
  private readonly db: SqlDriver
  private readonly blobs: BlobStore
  private readonly now: () => number
  private readonly onLocalChange: () => void
  private clock: Hlc | null = null
  private node = ''

  constructor(db: SqlDriver, blobs: BlobStore, now: () => number, onLocalChange: () => void) {
    this.db = db
    this.blobs = blobs
    this.now = now
    this.onLocalChange = onLocalChange
  }

  /** Loads this device's clock node id and moves the clock past every stored timestamp. */
  async init(): Promise<void> {
    let node = await this.getMeta('node')
    if (!node) {
      node = ulid().slice(-10)
      await this.setMeta('node', node)
    }
    this.node = node
    this.clock = new Hlc(node, this.now)
    const [row] = await this.db.select<{ ts: string | null }>('SELECT MAX(ts) AS ts FROM field_state')
    if (row?.ts) this.clock.observe(row.ts)
  }

  // ---------- Settings ----------

  async getMeta(key: string): Promise<string | null> {
    const rows = await this.db.select<{ value: string }>('SELECT value FROM sync_meta WHERE key = ?', [key])
    return rows[0]?.value ?? null
  }

  async setMeta(key: string, value: string): Promise<void> {
    await this.db.execute(
      'INSERT INTO sync_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      [key, value],
    )
  }

  async deleteMeta(key: string): Promise<void> {
    await this.db.execute('DELETE FROM sync_meta WHERE key = ?', [key])
  }

  // ---------- Local changes ----------

  /** Records that these fields of these records changed here. */
  async track(kind: RecordKind, ids: string | string[], fields: readonly string[]): Promise<void> {
    const list = Array.isArray(ids) ? ids : [ids]
    if (list.length === 0 || !this.clock) return
    const ts = this.clock.tick()
    const rows = list.flatMap((id) => fields.map((field) => [kind, id, field, ts]))
    for (let i = 0; i < rows.length; i += ROWS_PER_INSERT) {
      const chunk = rows.slice(i, i + ROWS_PER_INSERT)
      await this.db.execute(
        `INSERT INTO field_state (kind, id, field, ts, pending) VALUES ${chunk.map(() => '(?, ?, ?, ?, 1)').join(', ')}
         ON CONFLICT(kind, id, field) DO UPDATE SET ts = excluded.ts, pending = 1`,
        chunk.flat(),
      )
    }
    this.onLocalChange()
  }

  /** Records that a note body changed here. */
  async bodyChanged(noteId: string): Promise<void> {
    await this.db.execute(
      'INSERT INTO body_state (note_id, dirty) VALUES (?, 1) ON CONFLICT(note_id) DO UPDATE SET dirty = dirty + 1',
      [noteId],
    )
    this.onLocalChange()
  }

  /** Deletes notes forever (no history, no search entry) and remembers them so they stay deleted. */
  async purgeNotes(ids: string[]): Promise<void> {
    await this.write(ids.flatMap(purgeStatements))
  }

  // ---------- Push ----------

  /** Pending field changes with their current values. */
  async pendingRecords(limit: number): Promise<RecordChange[]> {
    const rows = await this.db.select<{ kind: RecordKind; id: string; field: string; ts: string }>(
      'SELECT kind, id, field, ts FROM field_state WHERE pending = 1 ORDER BY ts LIMIT ?',
      [limit],
    )
    const cache = new Map<string, Record<string, unknown> | null>()
    const changes: RecordChange[] = []
    const gone: RecordChange[] = []
    for (const r of rows) {
      const value = await this.valueOf(r.kind, r.id, r.field, cache)
      const change = { kind: r.kind, id: r.id, field: r.field, value, ts: r.ts }
      // A field of a record that no longer exists (a purged note): nothing to send.
      if (value === undefined) gone.push(change)
      else changes.push(change)
    }
    if (gone.length) await this.markPushed(gone)
    return changes
  }

  /** Clears pending for changes the server accepted, unless they changed again since. */
  async markPushed(changes: RecordChange[]): Promise<void> {
    for (let i = 0; i < changes.length; i += ROWS_PER_INSERT) {
      const keys = changes.slice(i, i + ROWS_PER_INSERT).map((c) => `${c.kind}|${c.id}|${c.field}|${c.ts}`)
      await this.db.execute(
        `UPDATE field_state SET pending = 0 WHERE kind || '|' || id || '|' || field || '|' || ts IN (${keys.map(() => '?').join(', ')})`,
        keys,
      )
    }
  }

  /** Bodies with unpushed edits, each as the part of the document the server doesn't have yet. */
  async pendingBodies(limit: number): Promise<PendingBody[]> {
    const rows = await this.db.select<{ note_id: string; dirty: number; server_sv: string | null }>(
      'SELECT note_id, dirty, server_sv FROM body_state WHERE dirty > 0 LIMIT ?',
      [limit],
    )
    const out: PendingBody[] = []
    for (const r of rows) {
      const merged = await this.mergedBody(r.note_id)
      if (!merged) {
        await this.db.execute('UPDATE body_state SET dirty = 0 WHERE note_id = ?', [r.note_id])
        continue
      }
      const diff = r.server_sv ? Y.diffUpdate(merged, fromBase64(r.server_sv)) : merged
      const sv = toBase64(Y.encodeStateVectorFromUpdate(merged))
      if (isEmptyUpdate(diff)) {
        await this.markBodiesPushed([{ noteId: r.note_id, data: '', dirty: r.dirty, sv }])
        continue
      }
      out.push({ noteId: r.note_id, data: toBase64(diff), dirty: r.dirty, sv })
    }
    return out
  }

  async markBodiesPushed(bodies: PendingBody[]): Promise<void> {
    for (const b of bodies) {
      await this.db.execute('UPDATE body_state SET dirty = MAX(dirty - ?, 0), server_sv = ? WHERE note_id = ?', [b.dirty, b.sv, b.noteId])
    }
  }

  // ---------- Pull ----------
  //
  // A pulled page (up to 1000 changes) is applied with a few bulk reads up front and one batch of writes, rather
  // than several database calls per change: on the tablet every call crosses from the web view to Android, and
  // every write outside a transaction is its own commit to disk. Where the platform batches, a page is also all
  // or nothing.

  /** Applies remote field changes that are newer than the local ones. */
  async applyRecords(changes: RecordChange[]): Promise<{ metadata: boolean; purged: string[] }> {
    const valid = changes.filter((c) => SYNC_FIELDS[c.kind]?.includes(c.field))
    for (const c of valid) this.clock?.observe(c.ts)
    const fieldKey = (c: { kind: string; id: string; field: string }) => `${c.kind}|${c.id}|${c.field}`
    const localTs = new Map<string, string>()
    const states = await this.selectIn<{ kind: string; id: string; field: string; ts: string }>(
      (marks) => `SELECT kind, id, field, ts FROM field_state WHERE id IN (${marks})`,
      unique(valid.map((c) => c.id)),
    )
    for (const r of states) localTs.set(fieldKey(r), r.ts)
    const noteIds = unique(valid.filter((c) => c.kind === 'note').map((c) => c.id))
    const purgedIds = await this.purgedAmong(noteIds)
    const notes = await this.notesAmong(noteIds)
    const hasBlob = new Map<string, boolean>()

    const writes: SqlStatement[] = []
    let metadata = false
    const purged: string[] = []
    for (const c of valid) {
      if (c.kind === 'note' && c.field !== 'purged' && purgedIds.has(c.id)) continue
      const local = localTs.get(fieldKey(c))
      if (local && local >= c.ts) continue
      if (c.kind === 'note' && c.field === 'purged') {
        if (c.value) {
          writes.push(...purgeStatements(c.id))
          purgedIds.add(c.id)
          notes.delete(c.id)
          purged.push(c.id)
        }
      } else {
        if (c.kind === 'attachment' && !hasBlob.has(c.id)) hasBlob.set(c.id, await this.blobs.has(c.id))
        writes.push(...fieldStatements(c, notes, hasBlob))
      }
      writes.push({
        sql: `INSERT INTO field_state (kind, id, field, ts, pending) VALUES (?, ?, ?, ?, 0)
         ON CONFLICT(kind, id, field) DO UPDATE SET ts = excluded.ts, pending = 0`,
        params: [c.kind, c.id, c.field, c.ts],
      })
      localTs.set(fieldKey(c), c.ts)
      metadata = true
    }
    await this.write(writes)
    return { metadata, purged }
  }

  /** Appends remote body updates and refreshes those notes' search text and snippets. */
  async applyBodies(updates: BodyUpdate[]): Promise<Map<string, Uint8Array[]>> {
    const noteIds = unique(updates.map((u) => u.noteId))
    const purgedIds = await this.purgedAmong(noteIds)
    const notes = await this.notesAmong(noteIds)
    const touched = new Map<string, Uint8Array[]>()
    const writes: SqlStatement[] = []
    for (const u of updates) {
      if (purgedIds.has(u.noteId)) continue
      writes.push(...ensureNoteStatements(u.noteId, notes))
      writes.push({ sql: 'INSERT INTO note_update (note_id, data) VALUES (?, ?)', params: [u.noteId, u.data] })
      touched.set(u.noteId, [...(touched.get(u.noteId) ?? []), fromBase64(u.data)])
    }
    await this.write(writes)

    // Each touched note's whole document, for its search text, snippet and state vector.
    const stored = new Map<string, Uint8Array[]>()
    const rows = await this.selectIn<{ note_id: string; data: string }>(
      (marks) => `SELECT note_id, data FROM note_update WHERE note_id IN (${marks}) ORDER BY seq`,
      [...touched.keys()],
    )
    for (const r of rows) stored.set(r.note_id, [...(stored.get(r.note_id) ?? []), fromBase64(r.data)])
    const refresh: SqlStatement[] = []
    for (const [noteId, parts] of stored) {
      const merged = Y.mergeUpdates(parts)
      const text = bodyText(merged)
      refresh.push(
        { sql: 'UPDATE note SET snippet = ? WHERE id = ?', params: [snippetOf(text), noteId] },
        { sql: 'UPDATE note_fts SET body = ? WHERE rowid = (SELECT rid FROM note WHERE id = ?)', params: [text, noteId] },
        // With no local edits pending, the server has exactly this document.
        {
          sql: `INSERT INTO body_state (note_id, dirty, server_sv) VALUES (?, 0, ?)
         ON CONFLICT(note_id) DO UPDATE SET server_sv = CASE WHEN dirty = 0 THEN excluded.server_sv ELSE server_sv END`,
          params: [noteId, toBase64(Y.encodeStateVectorFromUpdate(merged))],
        },
      )
    }
    await this.write(refresh)
    return touched
  }

  // ---------- Attachments ----------

  async missingBlobs(limit: number): Promise<string[]> {
    const rows = await this.db.select<{ hash: string }>('SELECT hash FROM blob_missing LIMIT ?', [limit])
    return rows.map((r) => r.hash)
  }

  async blobArrived(hash: string): Promise<void> {
    await this.db.execute('DELETE FROM blob_missing WHERE hash = ?', [hash])
  }

  // ---------- Enrollment ----------

  /** Whether this device has any notes (live or trashed). */
  async hasNotes(): Promise<boolean> {
    const [row] = await this.db.select<{ n: number }>('SELECT COUNT(*) AS n FROM note')
    return row.n > 0
  }

  /**
   * Marks everything on this device for upload, for a first sync. Values that were never edited since sync
   * existed get a timestamp from their last-modified time, so newer edits elsewhere still win.
   */
  async seedAll(): Promise<void> {
    const seed = async (kind: RecordKind, fields: readonly string[], tsColumn: string) => {
      const { table, key } = TABLE[kind]
      for (const field of fields) {
        await this.db.execute(
          `INSERT OR IGNORE INTO field_state (kind, id, field, ts, pending)
           SELECT ?, ${key}, ?, printf('%015d:%06d:%s', ${tsColumn}, 0, ?), 1 FROM ${table}`,
          [kind, field, this.node],
        )
      }
    }
    await seed('notebook', SYNC_FIELDS.notebook, 'updated_at')
    await seed('tag', SYNC_FIELDS.tag, 'updated_at')
    await seed('note', SYNC_FIELDS.note.filter((f) => f !== 'purged'), 'updated_at')
    await seed('attachment', SYNC_FIELDS.attachment, 'created_at')
    await seed('vault_key', SYNC_FIELDS.vault_key, 'created_at')
    await this.db.execute(
      `INSERT OR IGNORE INTO field_state (kind, id, field, ts, pending)
       SELECT 'note', id, 'purged', ?, 1 FROM purged_note`,
      [this.clock?.tick() ?? Hlc.at(this.now(), this.node)],
    )
    await this.db.execute('UPDATE field_state SET pending = 1')
    await this.db.execute(
      `INSERT INTO body_state (note_id, dirty, server_sv) SELECT DISTINCT note_id, 1, NULL FROM note_update WHERE true
       ON CONFLICT(note_id) DO UPDATE SET dirty = dirty + 1, server_sv = NULL`,
    )
  }

  /** Removes all notes, notebooks, tags, attachments and vault keys here (a fresh device joining a server that has data). */
  async resetLocalData(): Promise<void> {
    for (const table of ['notebook', 'tag', 'note', 'note_tag', 'note_update', 'note_fts', 'attachment', 'field_state', 'body_state', 'purged_note', 'blob_missing', 'vault_key']) {
      await this.db.execute(`DELETE FROM ${table}`)
    }
  }

  // ---------- Internals ----------

  private async isPurged(noteId: string): Promise<boolean> {
    const rows = await this.db.select('SELECT 1 FROM purged_note WHERE id = ?', [noteId])
    return rows.length > 0
  }

  /** Runs writes as one batch where the platform supports it, else one by one. */
  private async write(statements: SqlStatement[]): Promise<void> {
    if (statements.length === 0) return
    if (this.db.batch) {
      await this.db.batch(statements)
      return
    }
    for (const st of statements) await this.db.execute(st.sql, st.params)
  }

  /** A query with an `IN (…)` list, run in chunks that stay under SQLite's parameter limit. */
  private async selectIn<T>(sql: (marks: string) => string, ids: string[]): Promise<T[]> {
    const out: T[] = []
    for (let i = 0; i < ids.length; i += IDS_PER_QUERY) {
      const chunk = ids.slice(i, i + IDS_PER_QUERY)
      out.push(...(await this.db.select<T>(sql(chunk.map(() => '?').join(',')), chunk)))
    }
    return out
  }

  private async purgedAmong(noteIds: string[]): Promise<Set<string>> {
    const rows = await this.selectIn<{ id: string }>((marks) => `SELECT id FROM purged_note WHERE id IN (${marks})`, noteIds)
    return new Set(rows.map((r) => r.id))
  }

  private async notesAmong(noteIds: string[]): Promise<Set<string>> {
    const rows = await this.selectIn<{ id: string }>((marks) => `SELECT id FROM note WHERE id IN (${marks})`, noteIds)
    return new Set(rows.map((r) => r.id))
  }

  private async valueOf(
    kind: RecordKind,
    id: string,
    field: string,
    cache: Map<string, Record<string, unknown> | null>,
  ): Promise<unknown> {
    if (kind === 'note' && field === 'purged') return this.isPurged(id)
    const cacheKey = `${kind}|${id}`
    if (!cache.has(cacheKey)) {
      const { table, key } = TABLE[kind]
      const rows = await this.db.select<Record<string, unknown>>(`SELECT * FROM ${table} WHERE ${key} = ?`, [id])
      cache.set(cacheKey, rows[0] ?? null)
    }
    const row = cache.get(cacheKey)
    if (!row) return undefined
    if (kind === 'note' && field === 'tags') {
      const tags = await this.db.select<{ tag_id: string }>('SELECT tag_id FROM note_tag WHERE note_id = ? ORDER BY tag_id', [id])
      return tags.map((t) => t.tag_id)
    }
    return row[field] ?? null
  }

  private async mergedBody(noteId: string): Promise<Uint8Array | null> {
    const rows = await this.db.select<{ data: string }>('SELECT data FROM note_update WHERE note_id = ? ORDER BY seq', [noteId])
    return rows.length ? Y.mergeUpdates(rows.map((r) => fromBase64(r.data))) : null
  }
}

const unique = (ids: string[]) => [...new Set(ids)]

/** Removes a note for good, keeping only the tombstone that stops it coming back. */
function purgeStatements(id: string): SqlStatement[] {
  return [
    { sql: 'DELETE FROM note_fts WHERE rowid = (SELECT rid FROM note WHERE id = ?)', params: [id] },
    { sql: 'DELETE FROM note_update WHERE note_id = ?', params: [id] },
    { sql: 'DELETE FROM note_tag WHERE note_id = ?', params: [id] },
    { sql: 'DELETE FROM note WHERE id = ?', params: [id] },
    { sql: 'DELETE FROM body_state WHERE note_id = ?', params: [id] },
    { sql: "DELETE FROM field_state WHERE kind = 'note' AND id = ? AND field <> 'purged'", params: [id] },
    { sql: 'INSERT OR IGNORE INTO purged_note (id) VALUES (?)', params: [id] },
  ]
}

/** A placeholder note (and its search row), unless `notes`, the notes known to exist here, already has it. */
function ensureNoteStatements(id: string, notes: Set<string>): SqlStatement[] {
  if (notes.has(id)) return []
  notes.add(id)
  return [
    { sql: PLACEHOLDER.note, params: [id] },
    { sql: "INSERT INTO note_fts (rowid, title, body) VALUES ((SELECT rid FROM note WHERE id = ?), '', '')", params: [id] },
  ]
}

/** Writes one remote field value into the real tables. `hasBlob` says which attachment files are already here. */
function fieldStatements(c: RecordChange, notes: Set<string>, hasBlob: Map<string, boolean>): SqlStatement[] {
  const { table, key } = TABLE[c.kind]
  const out = c.kind === 'note' ? ensureNoteStatements(c.id, notes) : [{ sql: PLACEHOLDER[c.kind], params: [c.id] }]
  if (c.kind === 'note' && c.field === 'tags') {
    out.push({ sql: 'DELETE FROM note_tag WHERE note_id = ?', params: [c.id] })
    for (const tagId of new Set(Array.isArray(c.value) ? (c.value as string[]) : [])) {
      out.push({ sql: 'INSERT INTO note_tag (note_id, tag_id) VALUES (?, ?)', params: [c.id, tagId] })
    }
    return out
  }
  // The field name is one of SYNC_FIELDS (checked by the caller), so it is safe as a column name.
  out.push({ sql: `UPDATE ${table} SET ${c.field} = ? WHERE ${key} = ?`, params: [c.value ?? null, c.id] })
  if (c.kind === 'note' && c.field === 'title') {
    out.push({ sql: 'UPDATE note_fts SET title = ? WHERE rowid = (SELECT rid FROM note WHERE id = ?)', params: [c.value ?? '', c.id] })
  }
  if (c.kind === 'attachment' && !hasBlob.get(c.id)) {
    out.push({ sql: 'INSERT OR IGNORE INTO blob_missing (hash) VALUES (?)', params: [c.id] })
  }
  return out
}
