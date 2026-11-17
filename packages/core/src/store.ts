import { ulid } from 'ulid'
import * as Y from 'yjs'
import { fromBase64, sha256Hex, toBase64 } from './encoding'
import type { Attachment, Id, NoteMeta, NoteQuery, Notebook, Tag } from './model'
import { MIGRATIONS } from './schema'
import { descendantTagIds, wouldCreateCycle } from './tagTree'

/** Minimal SQL access implemented per platform (Tauri plugin-sql, Capacitor SQLite, node:sqlite in tests). */
export interface SqlDriver {
  execute(sql: string, params?: unknown[]): Promise<void>
  select<T>(sql: string, params?: unknown[]): Promise<T[]>
}

/** Content-addressed file storage for attachments, implemented per platform. */
export interface BlobStore {
  has(hash: string): Promise<boolean>
  put(hash: string, bytes: Uint8Array): Promise<void>
  /** URL the webview can load (e.g. Tauri asset protocol). */
  url(hash: string): string
}

const SNIPPET_LENGTH = 200
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

export class NoteStore {
  private readonly db: SqlDriver
  private readonly blobs: BlobStore
  private readonly now: () => number

  constructor(db: SqlDriver, blobs: BlobStore, now: () => number = Date.now) {
    this.db = db
    this.blobs = blobs
    this.now = now
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
    return nb
  }

  async renameNotebook(id: Id, name: string): Promise<void> {
    await this.db.execute('UPDATE notebook SET name = ?, updated_at = ? WHERE id = ?', [name.trim() || 'Untitled', this.now(), id])
  }

  /** Deletes the notebook and moves its notes to the trash. */
  async deleteNotebook(id: Id): Promise<void> {
    const t = this.now()
    await this.db.execute('UPDATE note SET deleted_at = ?, updated_at = ? WHERE notebook_id = ? AND deleted_at IS NULL', [t, t, id])
    await this.db.execute('UPDATE notebook SET deleted_at = ?, updated_at = ? WHERE id = ?', [t, t, id])
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
    const tag: Tag = { id: ulid(), parentId, name: name.trim() || 'tag', createdAt: t, updatedAt: t, deletedAt: null }
    await this.db.execute('INSERT INTO tag (id, parent_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [
      tag.id, parentId, tag.name, t, t,
    ])
    return tag
  }

  async renameTag(id: Id, name: string): Promise<void> {
    await this.db.execute('UPDATE tag SET name = ?, updated_at = ? WHERE id = ?', [name.trim() || 'tag', this.now(), id])
  }

  async moveTag(id: Id, parentId: Id | null): Promise<void> {
    if (wouldCreateCycle(await this.listTags(), id, parentId)) throw new Error('A tag cannot be moved under itself.')
    await this.db.execute('UPDATE tag SET parent_id = ?, updated_at = ? WHERE id = ?', [parentId, this.now(), id])
  }

  /** Deletes the tag and its descendants and removes them from notes. */
  async deleteTag(id: Id): Promise<void> {
    const ids = descendantTagIds(await this.listTags(), id)
    const t = this.now()
    const marks = ids.map(() => '?').join(',')
    await this.db.execute(`DELETE FROM note_tag WHERE tag_id IN (${marks})`, ids)
    await this.db.execute(`UPDATE tag SET deleted_at = ?, updated_at = ? WHERE id IN (${marks})`, [t, t, ...ids])
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
    return { id, notebookId, title, snippet: '', tagIds: [], createdAt: t, updatedAt: t, deletedAt: null }
  }

  async setNoteTitle(id: Id, title: string): Promise<void> {
    await this.db.execute('UPDATE note SET title = ?, updated_at = ? WHERE id = ?', [title, this.now(), id])
    await this.db.execute('UPDATE note_fts SET title = ? WHERE rowid = (SELECT rid FROM note WHERE id = ?)', [title, id])
  }

  async moveNote(id: Id, notebookId: Id): Promise<void> {
    await this.db.execute('UPDATE note SET notebook_id = ?, updated_at = ? WHERE id = ?', [notebookId, this.now(), id])
  }

  async setNoteTags(id: Id, tagIds: Id[]): Promise<void> {
    await this.db.execute('DELETE FROM note_tag WHERE note_id = ?', [id])
    for (const tagId of new Set(tagIds)) {
      await this.db.execute('INSERT INTO note_tag (note_id, tag_id) VALUES (?, ?)', [id, tagId])
    }
    await this.db.execute('UPDATE note SET updated_at = ? WHERE id = ?', [this.now(), id])
  }

  async trashNote(id: Id): Promise<void> {
    const t = this.now()
    await this.db.execute('UPDATE note SET deleted_at = ?, updated_at = ? WHERE id = ?', [t, t, id])
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
  }

  /** Permanently deletes a trashed note and its history. */
  async purgeNote(id: Id): Promise<void> {
    await this.db.execute('DELETE FROM note_fts WHERE rowid = (SELECT rid FROM note WHERE id = ?)', [id])
    await this.db.execute('DELETE FROM note_update WHERE note_id = ?', [id])
    await this.db.execute('DELETE FROM note_tag WHERE note_id = ?', [id])
    await this.db.execute('DELETE FROM note WHERE id = ?', [id])
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
    if (touch) await this.db.execute('UPDATE note SET updated_at = ? WHERE id = ?', [this.now(), id])
  }

  /** Updates the search index and list snippet from the body's plain text. */
  async indexNoteText(id: Id, text: string): Promise<void> {
    const snippet = text.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_LENGTH)
    await this.db.execute('UPDATE note SET snippet = ? WHERE id = ?', [snippet, id])
    await this.db.execute('UPDATE note_fts SET body = ? WHERE rowid = (SELECT rid FROM note WHERE id = ?)', [text, id])
  }

  // ---------- Attachments ----------

  async putAttachment(bytes: Uint8Array, mime: string, filename: string): Promise<Attachment> {
    const hash = await sha256Hex(bytes)
    if (!(await this.blobs.has(hash))) await this.blobs.put(hash, bytes)
    const att: Attachment = { hash, mime: mime || 'application/octet-stream', size: bytes.length, filename, createdAt: this.now() }
    await this.db.execute(
      'INSERT OR IGNORE INTO attachment (hash, mime, size, filename, created_at) VALUES (?, ?, ?, ?, ?)',
      [att.hash, att.mime, att.size, att.filename, att.createdAt],
    )
    return att
  }

  attachmentUrl(hash: string): string {
    return this.blobs.url(hash)
  }
}
