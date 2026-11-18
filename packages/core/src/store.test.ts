import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { NoteStore, ftsQuery, type BlobStore, type SqlDriver } from './store'
import { buildTagTree, tagPath } from './tagTree'

function memoryDriver(): SqlDriver {
  const db = new DatabaseSync(':memory:')
  return {
    async execute(sql, params = []) {
      db.prepare(sql).run(...(params as never[]))
    },
    async select<T>(sql: string, params: unknown[] = []) {
      return db.prepare(sql).all(...(params as never[])) as T[]
    },
  }
}

function memoryBlobs(): BlobStore & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>()
  return {
    files,
    async has(hash) {
      return files.has(hash)
    },
    async put(hash, bytes) {
      files.set(hash, bytes)
    },
    url: (hash) => `blob://${hash}`,
  }
}

let clock = 1_000
let store: NoteStore
let blobs: ReturnType<typeof memoryBlobs>

beforeEach(async () => {
  clock = 1_000
  blobs = memoryBlobs()
  store = new NoteStore(memoryDriver(), blobs, () => ++clock)
  await store.migrate()
})

describe('migrations', () => {
  it('are idempotent', async () => {
    await store.migrate()
    expect(await store.listNotebooks()).toEqual([])
  })
})

describe('notebooks and notes', () => {
  it('creates notes in notebooks and lists them newest first', async () => {
    const nb = await store.createNotebook('Work')
    const a = await store.createNote(nb.id, 'First')
    const b = await store.createNote(nb.id, 'Second')
    expect((await store.queryNotes({ notebookId: nb.id })).map((n) => n.id)).toEqual([b.id, a.id])
    expect((await store.queryNotes({ notebookId: nb.id, sort: 'title' })).map((n) => n.title)).toEqual(['First', 'Second'])
  })

  it('trashes, restores and purges', async () => {
    const nb = await store.createNotebook('Work')
    const n = await store.createNote(nb.id, 'Temp')
    await store.trashNote(n.id)
    expect(await store.queryNotes()).toHaveLength(0)
    expect(await store.queryNotes({ trash: true })).toHaveLength(1)
    await store.restoreNote(n.id, nb.id)
    expect(await store.queryNotes()).toHaveLength(1)
    await store.trashNote(n.id)
    await store.purgeNote(n.id)
    expect(await store.getNote(n.id)).toBeNull()
  })

  it('empties the trash, keeping live notes', async () => {
    const nb = await store.createNotebook('Work')
    const tag = await store.createTag('t')
    const keep = await store.createNote(nb.id, 'Keep')
    const a = await store.createNote(nb.id, 'Old a')
    const b = await store.createNote(nb.id, 'Old b')
    await store.setNoteTags(a.id, [tag.id])
    await store.trashNote(a.id)
    await store.trashNote(b.id)
    expect(await store.emptyTrash()).toBe(2)
    expect(await store.queryNotes({ trash: true })).toHaveLength(0)
    expect((await store.queryNotes()).map((n) => n.id)).toEqual([keep.id])
    expect(await store.emptyTrash()).toBe(0)
  })

  it('deleting a notebook trashes its notes; restore falls back to another notebook', async () => {
    const a = await store.createNotebook('A')
    const b = await store.createNotebook('B')
    const n = await store.createNote(a.id, 'x')
    await store.deleteNotebook(a.id)
    expect((await store.listNotebooks()).map((x) => x.name)).toEqual(['B'])
    await store.restoreNote(n.id, b.id)
    expect((await store.getNote(n.id))?.notebookId).toBe(b.id)
  })
})

describe('hierarchical tags', () => {
  it('filters by a tag including its descendants', async () => {
    const nb = await store.createNotebook('NB')
    const projects = await store.createTag('projects')
    const house = await store.createTag('house', projects.id)
    const kitchen = await store.createTag('kitchen', house.id)
    const other = await store.createTag('other')
    const n1 = await store.createNote(nb.id, 'kitchen note')
    const n2 = await store.createNote(nb.id, 'other note')
    await store.setNoteTags(n1.id, [kitchen.id])
    await store.setNoteTags(n2.id, [other.id])

    expect((await store.queryNotes({ tagId: projects.id })).map((n) => n.id)).toEqual([n1.id])
    expect((await store.queryNotes({ tagId: house.id })).map((n) => n.id)).toEqual([n1.id])
    expect((await store.queryNotes({ tagId: other.id })).map((n) => n.id)).toEqual([n2.id])

    const tags = await store.listTags()
    expect(tagPath(tags, kitchen.id)).toBe('projects/house/kitchen')
    expect(buildTagTree(tags).map((t) => t.tag.name)).toEqual(['other', 'projects'])
  })

  it('rejects moves that would create a cycle', async () => {
    const a = await store.createTag('a')
    const b = await store.createTag('b', a.id)
    await expect(store.moveTag(a.id, b.id)).rejects.toThrow()
  })

  it('deleting a tag removes it and its descendants from notes', async () => {
    const nb = await store.createNotebook('NB')
    const a = await store.createTag('a')
    const b = await store.createTag('b', a.id)
    const n = await store.createNote(nb.id, 'x')
    await store.setNoteTags(n.id, [b.id])
    await store.deleteTag(a.id)
    expect(await store.listTags()).toEqual([])
    expect((await store.getNote(n.id))?.tagIds).toEqual([])
  })
})

describe('full-text search', () => {
  it('matches title and body by word prefix, ignoring diacritics', async () => {
    const nb = await store.createNotebook('NB')
    const n1 = await store.createNote(nb.id, 'Kitchen renovation')
    const n2 = await store.createNote(nb.id, 'Groceries')
    await store.indexNoteText(n2.id, 'Buy café beans and oat milk')
    await store.indexNoteText(n1.id, 'Cabinets from the hardware store')

    expect((await store.queryNotes({ text: 'kitch' })).map((n) => n.id)).toEqual([n1.id])
    expect((await store.queryNotes({ text: 'cafe' })).map((n) => n.id)).toEqual([n2.id])
    expect((await store.queryNotes({ text: 'oat bea' })).map((n) => n.id)).toEqual([n2.id])
    expect(await store.queryNotes({ text: 'oat cabinets' })).toEqual([])
    expect((await store.getNote(n2.id))?.snippet).toBe('Buy café beans and oat milk')
  })

  it('ranks title matches first, scopes, and highlights excerpts', async () => {
    const work = await store.createNotebook('Work')
    const home = await store.createNotebook('Home')
    const inBody = await store.createNote(work.id, 'Meeting notes')
    await store.indexNoteText(inBody.id, 'We discussed the budget for the kitchen and then lunch')
    const inTitle = await store.createNote(home.id, 'Kitchen ideas')
    await store.indexNoteText(inTitle.id, 'Tiles and lights')
    const trashed = await store.createNote(home.id, 'Kitchen old')
    await store.trashNote(trashed.id)

    const hits = await store.searchNotes('kitchen')
    expect(hits.map((h) => h.note.id)).toEqual([inTitle.id, inBody.id])
    expect(hits[1].excerpt).toContain('kitchen')
    expect((await store.searchNotes('kitchen', { notebookId: work.id })).map((h) => h.note.id)).toEqual([inBody.id])
    expect(await store.searchNotes('  ')).toEqual([])
  })

  it('escapes quotes in user input', () => {
    expect(ftsQuery('say "hi"')).toBe('"say"* """hi"""*')
    expect(ftsQuery('   ')).toBeNull()
  })
})

describe('Yjs note bodies', () => {
  it('stores updates and reloads the same document, compacting long logs', async () => {
    const nb = await store.createNotebook('NB')
    const n = await store.createNote(nb.id, 'doc')
    const doc = new Y.Doc()
    doc.on('update', (u: Uint8Array) => void store.appendNoteUpdate(n.id, u))
    const text = doc.getText('t')
    for (let i = 0; i < 250; i++) text.insert(text.length, `${i} `)
    await new Promise((r) => setTimeout(r, 0))

    const loaded = new Y.Doc()
    Y.applyUpdate(loaded, (await store.loadNoteBody(n.id))!)
    expect(loaded.getText('t').toString()).toBe(text.toString())

    // Compaction happened on load; loading again yields the same content from one row.
    const again = new Y.Doc()
    Y.applyUpdate(again, (await store.loadNoteBody(n.id))!)
    expect(again.getText('t').toString()).toBe(text.toString())
  })
})

describe('import', () => {
  it('stores complete notes with original timestamps and detects re-imports', async () => {
    const nb = await store.findOrCreateNotebook('Recipes')
    expect((await store.findOrCreateNotebook('recipes')).id).toBe(nb.id)
    const tag = await store.findOrCreateTag('Dinner')
    expect((await store.findOrCreateTag('dinner')).id).toBe(tag.id)
    const doc = new Y.Doc()
    doc.getText('t').insert(0, 'body')
    const id = await store.importNote({
      notebookId: nb.id, title: 'Soup', createdAt: 1_250_000_000_000, updatedAt: 1_260_000_000_000,
      tagIds: [tag.id], body: Y.encodeStateAsUpdate(doc), text: 'Simmer the onions slowly',
    })
    const note = await store.getNote(id)
    expect(note).toMatchObject({ title: 'Soup', createdAt: 1_250_000_000_000, updatedAt: 1_260_000_000_000, tagIds: [tag.id] })
    expect(note?.snippet).toBe('Simmer the onions slowly')
    expect((await store.queryNotes({ text: 'onion' })).map((n) => n.id)).toEqual([id])
    expect(await store.findImportedNote(nb.id, 'Soup', 1_250_000_000_000)).toBe(id)
    expect(await store.findImportedNote(nb.id, 'Soup', 1)).toBeNull()
    const loaded = new Y.Doc()
    Y.applyUpdate(loaded, (await store.loadNoteBody(id))!)
    expect(loaded.getText('t').toString()).toBe('body')
  })
})

describe('attachments', () => {
  it('stores identical content once, keyed by SHA-256', async () => {
    const bytes = new TextEncoder().encode('hello')
    const a = await store.putAttachment(bytes, 'text/plain', 'a.txt')
    const b = await store.putAttachment(bytes, 'text/plain', 'b.txt')
    expect(a.hash).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
    expect(b.hash).toBe(a.hash)
    expect(blobs.files.size).toBe(1)
    expect(store.attachmentUrl(a.hash)).toBe(`blob://${a.hash}`)
  })
})
