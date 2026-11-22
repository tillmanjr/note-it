import { ulid } from 'ulid'
import * as Y from 'yjs'
import { BODY_FIELD, snippetOf } from './bodyText'
import { fromBase64, sha256Hex, toBase64 } from './encoding'
import { SyncLedger } from './ledger'
import type { Attachment, Id, NoteCounts, NoteMeta, NoteQuery, Notebook, Tag } from './model'
import { MIGRATIONS } from './schema'
import { cleanTagName, descendantTagIds, sameTagName, splitTagPath, wouldCreateCycle } from './tagTree'
import type { KeyWrap, VaultKeyRecord } from './vault'

/** Minimal SQL access implemented per platform (Tauri plugin-sql, Capacitor SQLite, node:sqlite in tests). */
export interface SqlDriver {
  execute(sql: string, params?: unknown[]): Promise<void>
  select<T>(sql: string, params?: unknown[]): Promise<T[]>
  /**
   * Runs the statements in order in one transaction (all or nothing), with as few round trips as the platform allows.
   * Optional: without it they run one by one. Sync uses it to apply a pulled page quickly (docs/sync.md).
   */
  batch?(statements: SqlStatement[]): Promise<void>
}

export interface SqlStatement {
  sql: string
  params: unknown[]
}

/** Content-addressed file storage for attachments, implemented per platform. */
export interface BlobStore {
  has(hash: string): Promise<boolean>
  put(hash: string, bytes: Uint8Array): Promise<void>
  /** The file's bytes, or null if it isn't stored here. */
  read(hash: string): Promise<Uint8Array | null>
  /** URL the webview can load (e.g. Tauri asset protocol). */
  url(hash: string): string
}

/** Updates kept per note before they are merged into one. */
const COMPACT_THRESHOLD = 200

interface NoteRow {
  id: string
  notebook_id: string
  title: string
  snippet: string
  created_at: number
  updated_at: number
  deleted_at: number | null
  tag_ids: string | null
}

const toNote = (r: NoteRow): NoteMeta => ({
  id: r.id,
  notebookId: r.notebook_id,
  title: r.title,
  snippet: r.snippet,
  tagIds: r.tag_ids ? r.tag_ids.split(',') : [],
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  deletedAt: r.deleted_at,
})

const NOTE_COLUMNS = `n.id, n.notebook_id, n.title, n.snippet, n.created_at, n.updated_at, n.deleted_at,
  (SELECT group_concat(tag_id) FROM note_tag WHERE note_id = n.id) AS tag_ids`

/** Marks around matched terms in search excerpts. */
export const HIT_START = ''
export const HIT_END = ''

export interface SearchHit {
  note: NoteMeta
  /** Body excerpt around the match; matched terms are wrapped in HIT_START/HIT_END. */
  excerpt: string
}

/** Turns user input into an FTS5 query: every word must match, as a prefix. */
export function ftsQuery(text: string): string | null {
  const words = text.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return null
  return words.map((w) => `"${w.replace(/"/g, '""')}"*`).join(' ')
}

/** `local`: something changed on this device. `remote`: changes arrived from another device. */
export type StoreEvent =
  | { type: 'local' }
  | { type: 'remote'; metadata: boolean; purged: string[]; bodies: Map<Id, Uint8Array[]> }

const NOTEBOOK_FIELDS = ['name', 'sort', 'created_at', 'updated_at', 'deleted_at'] as const
const TAG_FIELDS = ['parent_id', 'name', 'created_at', 'updated_at', 'deleted_at'] as const
const NOTE_FIELDS = ['notebook_id', 'title', 'created_at', 'updated_at', 'deleted_at', 'tags'] as const
const ATTACHMENT_FIELDS = ['mime', 'size', 'filename', 'created_at'] as const
const VAULT_KEY_FIELDS = ['wrap', 'created_at'] as const

export class NoteStore {
  private readonly db: SqlDriver
  readonly blobs: BlobStore
  private readonly now: () => number
  /** Sync bookkeeping: every change below is recorded here for upload. */
  readonly ledger: SyncLedger
  private readonly listeners = new Set<(e: StoreEvent) => void>()

  constructor(db: SqlDriver, blobs: BlobStore, now: () => number = Date.now) {
    this.db = db
    this.blobs = blobs
    this.now = now
    this.ledger = new SyncLedger(db, blobs, now, () => this.emit({ type: 'local' }))
  }

  /** Subscribes to changes; returns the unsubscribe function. */
  onChange(listener: (e: StoreEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(e: StoreEvent): void {
    for (const l of this.listeners) l(e)
  }

  async migrate(): Promise<void> {
    await this.db.execute('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)')
    const rows = await this.db.select<{ version: number }>('SELECT version FROM schema_version')
    let version = rows[0]?.version ?? 0
    if (rows.length === 0) await this.db.execute('INSERT INTO schema_version (version) VALUES (0)')
    for (; version < MIGRATIONS.length; version++) {
      for (const stmt of MIGRATIONS[version]) await this.db.execute(stmt)
      await this.db.execute('UPDATE schema_version SET version = ?', [version + 1])
    }
    await this.ledger.init()
  }

  // ---------- Notebooks ----------

  async listNotebooks(): Promise<Notebook[]> {
    const rows = await this.db.select<Record<string, unknown>>(
      'SELECT * FROM notebook WHERE deleted_at IS NULL ORDER BY sort, name COLLATE NOCASE',
    )
    return rows.map((r) => ({
      id: r.id as string,
      name: r.name as string,
      sort: r.sort as number,
      createdAt: r.created_at as number,
      updatedAt: r.updated_at as number,
      deletedAt: (r.deleted_at as number | null) ?? null,
    }))
  }

  async createNotebook(name: string): Promise<Notebook> {
    const t = this.now()
    const nb: Notebook = { id: ulid(), name: name.trim() || 'Untitled', sort: 0, createdAt: t, updatedAt: t, deletedAt: null }
    await this.db.execute('INSERT INTO notebook (id, name, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [
      nb.id, nb.name, nb.sort, t, t,
    ])
    await this.ledger.track('notebook', nb.id, NOTEBOOK_FIELDS)
    return nb
  }

  async renameNotebook(id: Id, name: string): Promise<void> {
    await this.db.execute('UPDATE notebook SET name = ?, updated_at = ? WHERE id = ?', [name.trim() || 'Untitled', this.now(), id])
    await this.ledger.track('notebook', id, ['name', 'updated_at'])
  }

  /** Deletes the notebook and moves its notes to the trash. */
  async deleteNotebook(id: Id): Promise<void> {
    const t = this.now()
    const noteIds = await this.ids('SELECT id FROM note WHERE notebook_id = ? AND deleted_at IS NULL', [id])
    await this.db.execute('UPDATE note SET deleted_at = ?, updated_at = ? WHERE notebook_id = ? AND deleted_at IS NULL', [t, t, id])
    await this.db.execute('UPDATE notebook SET deleted_at = ?, updated_at = ? WHERE id = ?', [t, t, id])
    await this.ledger.track('note', noteIds, ['deleted_at', 'updated_at'])
    await this.ledger.track('notebook', id, ['deleted_at', 'updated_at'])
  }

  // ---------- Tags ----------

  async listTags(): Promise<Tag[]> {
    const rows = await this.db.select<Record<string, unknown>>('SELECT * FROM tag WHERE deleted_at IS NULL')
    return rows.map((r) => ({
      id: r.id as string,
      parentId: (r.parent_id as string | null) ?? null,
      name: r.name as string,
      createdAt: r.created_at as number,
      updatedAt: r.updated_at as number,
      deletedAt: (r.deleted_at as number | null) ?? null,
    }))
  }

  async createTag(name: string, parentId: Id | null = null): Promise<Tag> {
    const t = this.now()
    const tag: Tag = { id: ulid(), parentId, name: cleanTagName(name) || 'tag', createdAt: t, updatedAt: t, deletedAt: null }
    await this.db.execute('INSERT INTO tag (id, parent_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [
      tag.id, parentId, tag.name, t, t,
    ])
    await this.ledger.track('tag', tag.id, TAG_FIELDS)
    return tag
  }

  async renameTag(id: Id, name: string): Promise<void> {
    await this.db.execute('UPDATE tag SET name = ?, updated_at = ? WHERE id = ?', [cleanTagName(name) || 'tag', this.now(), id])
    await this.ledger.track('tag', id, ['name', 'updated_at'])
  }

  /**
   * Moves a tag (with its notes and sub-tags) under `parentId`, or to the top level. If a tag of the same name is
   * already there, nothing changes and it comes back as `conflict`, unless `merge` is set: then the tag is merged into it.
   */
  async moveTag(id: Id, parentId: Id | null, { merge = false } = {}): Promise<{ conflict: Tag | null }> {
    const tags = await this.listTags()
    const tag = tags.find((t) => t.id === id)
    if (!tag) return { conflict: null }
    if (wouldCreateCycle(tags, id, parentId)) throw new Error('A tag cannot be moved under itself.')
    return this.placeTag(tags, tag, parentId, tag.name, merge)
  }

  /**
   * Gives a tag a new place and name from its full path ("fruit/citrus/lemons"), creating missing parents. The tag
   * keeps its notes and sub-tags, so renaming top-level "foo" to "foo/bar" makes it "bar" under a new "foo".
   * A tag already at that path comes back as `conflict` with nothing changed, unless `merge` is set.
   */
  async relocateTag(id: Id, path: string, { merge = false } = {}): Promise<{ conflict: Tag | null }> {
    const parts = splitTagPath(path)
    const tags = await this.listTags()
    const tag = tags.find((t) => t.id === id)
    if (!tag || parts.length === 0) return { conflict: null }
    const name = parts.pop()!
    // The parent path is looked up without the tag itself (and so without its sub-tags): "foo" → "foo/bar" needs a new "foo".
    const others = tags.filter((t) => t.id !== id)
    let parentId: Id | null = null
    let missing = parts
    for (const [i, part] of parts.entries()) {
      const found = others.find((t) => t.parentId === parentId && sameTagName(t.name, part))
      if (!found) break
      parentId = found.id
      missing = parts.slice(i + 1)
    }
    // A conflict needs the whole parent path to exist already, so check before creating anything.
    if (missing.length === 0) return this.placeTag(tags, tag, parentId, name, merge)
    for (const part of missing) parentId = (await this.createTag(part, parentId)).id
    return this.placeTag(tags, tag, parentId, name, merge)
  }

  private async placeTag(tags: Tag[], tag: Tag, parentId: Id | null, name: string, merge: boolean): Promise<{ conflict: Tag | null }> {
    const clean = cleanTagName(name) || 'tag'
    const twin = tags.find((t) => t.id !== tag.id && t.parentId === parentId && sameTagName(t.name, clean))
    if (twin) {
      if (!merge) return { conflict: twin }
      await this.mergeTag(tag.id, twin.id)
      return { conflict: null }
    }
    if (tag.parentId === parentId && tag.name === clean) return { conflict: null }
    await this.db.execute('UPDATE tag SET parent_id = ?, name = ?, updated_at = ? WHERE id = ?', [parentId, clean, this.now(), tag.id])
    await this.ledger.track('tag', tag.id, ['parent_id', 'name', 'updated_at'])
    return { conflict: null }
  }

  /**
   * Merges `sourceId` into `targetId`: its notes get the target tag, its sub-tags move under the target (merging again
   * where a sub-tag of the same name is already there), and the source tag is deleted.
   */
  async mergeTag(sourceId: Id, targetId: Id): Promise<void> {
    if (sourceId === targetId) return
    const tags = await this.listTags()
    if (wouldCreateCycle(tags, sourceId, targetId)) throw new Error('A tag cannot be merged into its own sub-tag.')
    const noteIds = await this.ids('SELECT note_id AS id FROM note_tag WHERE tag_id = ?', [sourceId])
    await this.db.execute('INSERT OR IGNORE INTO note_tag (note_id, tag_id) SELECT note_id, ? FROM note_tag WHERE tag_id = ?', [targetId, sourceId])
    await this.db.execute('DELETE FROM note_tag WHERE tag_id = ?', [sourceId])
    for (const child of tags.filter((t) => t.parentId === sourceId)) {
      const twin = tags.find((t) => t.parentId === targetId && sameTagName(t.name, child.name))
      if (twin) {
        await this.mergeTag(child.id, twin.id)
      } else {
        await this.db.execute('UPDATE tag SET parent_id = ?, updated_at = ? WHERE id = ?', [targetId, this.now(), child.id])
        await this.ledger.track('tag', child.id, ['parent_id', 'updated_at'])
      }
    }
    const t = this.now()
    await this.db.execute('UPDATE tag SET deleted_at = ?, updated_at = ? WHERE id = ?', [t, t, sourceId])
    await this.ledger.track('note', noteIds, ['tags'])
    await this.ledger.track('tag', sourceId, ['deleted_at', 'updated_at'])
  }

  /** The tag at a path like "projects/house", creating any missing levels. Null for an empty path. */
  async findOrCreateTagPath(path: string): Promise<{ id: Id; created: boolean } | null> {
    const parts = splitTagPath(path)
    if (parts.length === 0) return null
    const tags = await this.listTags()
    let parentId: Id | null = null
    let created = false
    for (const part of parts) {
      const found = tags.find((t) => t.parentId === parentId && sameTagName(t.name, part))
      if (found) {
        parentId = found.id
      } else {
        parentId = (await this.createTag(part, parentId)).id
        created = true
      }
    }
    return { id: parentId!, created }
  }

  /** Deletes the tag and its descendants and removes them from notes. */
  async deleteTag(id: Id): Promise<void> {
    const ids = descendantTagIds(await this.listTags(), id)
    const t = this.now()
    const marks = ids.map(() => '?').join(',')
    const noteIds = await this.ids(`SELECT DISTINCT note_id AS id FROM note_tag WHERE tag_id IN (${marks})`, ids)
    await this.db.execute(`DELETE FROM note_tag WHERE tag_id IN (${marks})`, ids)
    await this.db.execute(`UPDATE tag SET deleted_at = ?, updated_at = ? WHERE id IN (${marks})`, [t, t, ...ids])
    await this.ledger.track('note', noteIds, ['tags'])
    await this.ledger.track('tag', ids, ['deleted_at', 'updated_at'])
  }

  /**
   * Live-note counts for the left pane. A tag counts notes tagged with it or any sub-tag (each note once),
   * matching what filtering by that tag shows.
   */
  async noteCounts(): Promise<NoteCounts> {
    const [byNotebook, tagged, tags] = await Promise.all([
      this.db.select<{ id: string; n: number }>('SELECT notebook_id AS id, COUNT(*) AS n FROM note WHERE deleted_at IS NULL GROUP BY notebook_id'),
      this.db.select<{ note_id: string; tag_id: string }>(
        'SELECT nt.note_id, nt.tag_id FROM note_tag nt JOIN note n ON n.id = nt.note_id WHERE n.deleted_at IS NULL',
      ),
      this.listTags(),
    ])
    const parent = new Map(tags.map((t) => [t.id, t.parentId]))
    const notesByTag = new Map<Id, Set<Id>>()
    for (const { note_id, tag_id } of tagged) {
      // Credit the tag and each ancestor; the set keeps a note tagged twice in one branch from counting twice.
      const seen = new Set<Id>()
      for (let id: Id | null | undefined = tag_id; id && parent.has(id) && !seen.has(id); id = parent.get(id)) {
        seen.add(id)
        let set = notesByTag.get(id)
        if (!set) notesByTag.set(id, (set = new Set()))
        set.add(note_id)
      }
    }
    const notebooks: Record<Id, number> = {}
    let all = 0
    for (const r of byNotebook) {
      notebooks[r.id] = Number(r.n)
      all += Number(r.n)
    }
    const tagCounts: Record<Id, number> = {}
    for (const [id, set] of notesByTag) tagCounts[id] = set.size
    return { all, notebooks, tags: tagCounts }
  }

  // ---------- Notes ----------

  async queryNotes(q: NoteQuery = {}): Promise<NoteMeta[]> {
    const where: string[] = [q.trash ? 'n.deleted_at IS NOT NULL' : 'n.deleted_at IS NULL']
    const params: unknown[] = []
    if (q.notebookId) {
      where.push('n.notebook_id = ?')
      params.push(q.notebookId)
    }
    if (q.tagId) {
      const ids = descendantTagIds(await this.listTags(), q.tagId)
      where.push(`EXISTS (SELECT 1 FROM note_tag nt WHERE nt.note_id = n.id AND nt.tag_id IN (${ids.map(() => '?').join(',')}))`)
      params.push(...ids)
    }
    const match = q.text ? ftsQuery(q.text) : null
    if (match) {
      where.push('n.rid IN (SELECT rowid FROM note_fts WHERE note_fts MATCH ?)')
      params.push(match)
    }
    const order = { updated: 'n.updated_at DESC', created: 'n.created_at DESC', title: 'n.title COLLATE NOCASE ASC' }[q.sort ?? 'updated']
    params.push(q.limit ?? 5000)
    const rows = await this.db.select<NoteRow>(
      `SELECT ${NOTE_COLUMNS} FROM note n WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ?`,
      params,
    )
    return rows.map(toNote)
  }

  /** Ranked full-text search over live notes (title matches weigh more), with highlighted excerpts. */
  async searchNotes(text: string, scope: { notebookId?: Id; tagId?: Id; limit?: number } = {}): Promise<SearchHit[]> {
    const match = ftsQuery(text)
    if (!match) return []
    const where = ['note_fts MATCH ?', 'n.deleted_at IS NULL']
    const params: unknown[] = [match]
    if (scope.notebookId) {
      where.push('n.notebook_id = ?')
      params.push(scope.notebookId)
    }
    if (scope.tagId) {
      const ids = descendantTagIds(await this.listTags(), scope.tagId)
      where.push(`EXISTS (SELECT 1 FROM note_tag nt WHERE nt.note_id = n.id AND nt.tag_id IN (${ids.map(() => '?').join(',')}))`)
      params.push(...ids)
    }
    params.push(scope.limit ?? 50)
    const rows = await this.db.select<NoteRow & { excerpt: string }>(
      `SELECT ${NOTE_COLUMNS}, snippet(note_fts, 1, char(1), char(2), '…', 14) AS excerpt
       FROM note_fts JOIN note n ON n.rid = note_fts.rowid
       WHERE ${where.join(' AND ')}
       ORDER BY bm25(note_fts, 10.0, 1.0) LIMIT ?`,
      params,
    )
    return rows.map((r) => ({ note: toNote(r), excerpt: r.excerpt ?? '' }))
  }

  async getNote(id: Id): Promise<NoteMeta | null> {
    const rows = await this.db.select<NoteRow>(`SELECT ${NOTE_COLUMNS} FROM note n WHERE n.id = ?`, [id])
    return rows[0] ? toNote(rows[0]) : null
  }

  async createNote(notebookId: Id, title = ''): Promise<NoteMeta> {
    const t = this.now()
    const id = ulid()
    await this.db.execute('INSERT INTO note (id, notebook_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [
      id, notebookId, title, t, t,
    ])
    await this.db.execute('INSERT INTO note_fts (rowid, title, body) VALUES ((SELECT rid FROM note WHERE id = ?), ?, ?)', [id, title, ''])
    await this.ledger.track('note', id, NOTE_FIELDS)
    return { id, notebookId, title, snippet: '', tagIds: [], createdAt: t, updatedAt: t, deletedAt: null }
  }

  /** A new note holding plain text, one paragraph per line (text shared from another app). */
  async createTextNote(notebookId: Id, title: string, text: string): Promise<NoteMeta> {
    const note = await this.createNote(notebookId, title)
    const doc = new Y.Doc()
    const lines = text.replace(/\r\n?/g, '\n').split('\n')
    doc.getXmlFragment(BODY_FIELD).push(
      lines.map((line) => {
        const p = new Y.XmlElement('paragraph')
        if (line) p.insert(0, [new Y.XmlText(line)])
        return p
      }),
    )
    await this.appendNoteUpdate(note.id, Y.encodeStateAsUpdate(doc))
    await this.indexNoteText(note.id, text)
    return { ...note, snippet: snippetOf(text) }
  }

  async setNoteTitle(id: Id, title: string): Promise<void> {
    await this.db.execute('UPDATE note SET title = ?, updated_at = ? WHERE id = ?', [title, this.now(), id])
    await this.db.execute('UPDATE note_fts SET title = ? WHERE rowid = (SELECT rid FROM note WHERE id = ?)', [title, id])
    await this.ledger.track('note', id, ['title', 'updated_at'])
  }

  async moveNote(id: Id, notebookId: Id): Promise<void> {
    await this.db.execute('UPDATE note SET notebook_id = ?, updated_at = ? WHERE id = ?', [notebookId, this.now(), id])
    await this.ledger.track('note', id, ['notebook_id', 'updated_at'])
  }

  async setNoteTags(id: Id, tagIds: Id[]): Promise<void> {
    await this.db.execute('DELETE FROM note_tag WHERE note_id = ?', [id])
    for (const tagId of new Set(tagIds)) {
      await this.db.execute('INSERT INTO note_tag (note_id, tag_id) VALUES (?, ?)', [id, tagId])
    }
    await this.db.execute('UPDATE note SET updated_at = ? WHERE id = ?', [this.now(), id])
    await this.ledger.track('note', id, ['tags', 'updated_at'])
  }

  async trashNote(id: Id): Promise<void> {
    const t = this.now()
    await this.db.execute('UPDATE note SET deleted_at = ?, updated_at = ? WHERE id = ?', [t, t, id])
    await this.ledger.track('note', id, ['deleted_at', 'updated_at'])
  }

  /** Restores a trashed note; if its notebook was deleted, into `fallbackNotebookId`. */
  async restoreNote(id: Id, fallbackNotebookId: Id): Promise<void> {
    await this.db.execute(
      `UPDATE note SET deleted_at = NULL, updated_at = ?,
         notebook_id = CASE WHEN EXISTS (SELECT 1 FROM notebook WHERE id = note.notebook_id AND deleted_at IS NULL)
                            THEN notebook_id ELSE ? END
       WHERE id = ?`,
      [this.now(), fallbackNotebookId, id],
    )
    await this.ledger.track('note', id, ['deleted_at', 'updated_at', 'notebook_id'])
  }

  /** Permanently deletes a trashed note and its history. */
  async purgeNote(id: Id): Promise<void> {
    await this.ledger.purgeNotes([id])
    await this.ledger.track('note', id, ['purged'])
  }

  /** Permanently deletes every trashed note and its history. Returns how many were deleted. */
  async emptyTrash(): Promise<number> {
    const ids = await this.ids('SELECT id FROM note WHERE deleted_at IS NOT NULL')
    await this.ledger.purgeNotes(ids)
    await this.ledger.track('note', ids, ['purged'])
    return ids.length
  }

  // ---------- Note bodies (Yjs) ----------

  /** The note body as a single Yjs update (merged from the stored log), or null if it has none yet. */
  async loadNoteBody(id: Id): Promise<Uint8Array | null> {
    const rows = await this.db.select<{ seq: number; data: string }>('SELECT seq, data FROM note_update WHERE note_id = ? ORDER BY seq', [id])
    if (rows.length === 0) return null
    const merged = Y.mergeUpdates(rows.map((r) => fromBase64(r.data)))
    if (rows.length > COMPACT_THRESHOLD) {
      // Insert the merged state before deleting the parts: a crash in between only leaves harmless duplicates.
      await this.db.execute('INSERT INTO note_update (note_id, data) VALUES (?, ?)', [id, toBase64(merged)])
      await this.db.execute('DELETE FROM note_update WHERE note_id = ? AND seq <= ?', [id, rows[rows.length - 1].seq])
    }
    return merged
  }

  /** `touch`: whether this counts as an edit for "last edited" (false for editor bookkeeping updates). */
  async appendNoteUpdate(id: Id, update: Uint8Array, touch = true): Promise<void> {
    await this.db.execute('INSERT INTO note_update (note_id, data) VALUES (?, ?)', [id, toBase64(update)])
    await this.ledger.bodyChanged(id)
    if (touch) {
      await this.db.execute('UPDATE note SET updated_at = ? WHERE id = ?', [this.now(), id])
      await this.ledger.track('note', id, ['updated_at'])
    }
  }

  /** Updates the search index and list snippet from the body's plain text. */
  async indexNoteText(id: Id, text: string): Promise<void> {
    await this.db.execute('UPDATE note SET snippet = ? WHERE id = ?', [snippetOf(text), id])
    await this.db.execute('UPDATE note_fts SET body = ? WHERE rowid = (SELECT rid FROM note WHERE id = ?)', [text, id])
  }

  // ---------- Import ----------

  /** Live notebook with this name (case-insensitive), or a new one. */
  async findOrCreateNotebook(name: string): Promise<Notebook> {
    const existing = (await this.listNotebooks()).find((n) => n.name.localeCompare(name, undefined, { sensitivity: 'base' }) === 0)
    return existing ?? this.createNotebook(name)
  }

  /** Live tag with this name under `parentId` (case-insensitive), or a new one. */
  async findOrCreateTag(name: string, parentId: Id | null = null): Promise<Tag> {
    const existing = (await this.listTags()).find(
      (t) => t.parentId === parentId && t.name.localeCompare(cleanTagName(name), undefined, { sensitivity: 'base' }) === 0,
    )
    return existing ?? this.createTag(name, parentId)
  }

  /** A live note in the notebook with the same title and creation time (re-import detection). */
  async findImportedNote(notebookId: Id, title: string, createdAt: number): Promise<Id | null> {
    const rows = await this.db.select<{ id: string }>(
      'SELECT id FROM note WHERE notebook_id = ? AND title = ? AND created_at = ? AND deleted_at IS NULL LIMIT 1',
      [notebookId, title, createdAt],
    )
    return rows[0]?.id ?? null
  }

  /** Inserts a complete note (original timestamps, tags, Yjs body, plain text) in one go. */
  async importNote(input: {
    notebookId: Id
    title: string
    createdAt: number
    updatedAt: number
    tagIds: Id[]
    body: Uint8Array
    text: string
  }): Promise<Id> {
    const id = ulid(input.createdAt)
    const snippet = snippetOf(input.text)
    await this.db.execute(
      'INSERT INTO note (id, notebook_id, title, snippet, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [id, input.notebookId, input.title, snippet, input.createdAt, input.updatedAt],
    )
    await this.db.execute('INSERT INTO note_fts (rowid, title, body) VALUES ((SELECT rid FROM note WHERE id = ?), ?, ?)', [
      id, input.title, input.text,
    ])
    for (const tagId of new Set(input.tagIds)) {
      await this.db.execute('INSERT INTO note_tag (note_id, tag_id) VALUES (?, ?)', [id, tagId])
    }
    await this.db.execute('INSERT INTO note_update (note_id, data) VALUES (?, ?)', [id, toBase64(input.body)])
    await this.ledger.track('note', id, NOTE_FIELDS)
    await this.ledger.bodyChanged(id)
    return id
  }

  // ---------- Vault keys (docs/vault.md) ----------

  /** The vault's keys, oldest first. Usually one; more only if two devices set up a vault while offline. */
  async listVaultKeys(): Promise<VaultKeyRecord[]> {
    const rows = await this.db.select<{ id: string; wrap: string; created_at: number }>(
      `SELECT id, wrap, created_at FROM vault_key WHERE deleted_at IS NULL AND wrap != '' ORDER BY created_at, id`,
    )
    return rows.flatMap((r) => {
      try {
        return [{ id: r.id, wrap: JSON.parse(r.wrap) as KeyWrap, createdAt: r.created_at }]
      } catch {
        return []
      }
    })
  }

  /** Adds a new vault key, or stores a rewrapped one (a passphrase change). */
  async saveVaultKey(record: VaultKeyRecord): Promise<void> {
    await this.db.execute(
      `INSERT INTO vault_key (id, wrap, created_at) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET wrap = excluded.wrap`,
      [record.id, JSON.stringify(record.wrap), record.createdAt],
    )
    await this.ledger.track('vault_key', record.id, VAULT_KEY_FIELDS)
  }

  // ---------- Attachments ----------

  async putAttachment(bytes: Uint8Array, mime: string, filename: string): Promise<Attachment> {
    const hash = await sha256Hex(bytes)
    if (!(await this.blobs.has(hash))) await this.blobs.put(hash, bytes)
    const att: Attachment = { hash, mime: mime || 'application/octet-stream', size: bytes.length, filename, createdAt: this.now() }
    const known = await this.db.select('SELECT 1 FROM attachment WHERE hash = ?', [hash])
    if (known.length === 0) {
      await this.db.execute(
        'INSERT INTO attachment (hash, mime, size, filename, created_at) VALUES (?, ?, ?, ?, ?)',
        [att.hash, att.mime, att.size, att.filename, att.createdAt],
      )
      await this.ledger.track('attachment', hash, ATTACHMENT_FIELDS)
    }
    return att
  }

  attachmentUrl(hash: string): string {
    return this.blobs.url(hash)
  }

  private async ids(sql: string, params: unknown[] = []): Promise<Id[]> {
    return (await this.db.select<{ id: string }>(sql, params)).map((r) => r.id)
  }
}
