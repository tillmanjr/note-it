import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { md5 } from '@noble/hashes/legacy.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { NoteStore, type BlobStore, type SqlDriver } from '@tdjr/core'
import { CONTRAST_MAX, isNearBlack } from '@tdjr/editor'
import { convertNote, importNotes, notebookNameFromFile, parseEnex, parseEnexDate, type MediaRef } from './index'
import type { JSONContent } from '@tiptap/core'

const enml = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd"><en-note>${body}</en-note>`

const convert = (body: string, media = new Map<string, MediaRef>()) => convertNote(enml(body), media)
const blocks = (json: JSONContent) => json.content ?? []
const textOf = (n: JSONContent): string => (n.text ?? '') + (n.content ?? []).map(textOf).join('')

describe('parseEnex', () => {
  it('reads notes, dates, tags and resources', () => {
    const data = btoa('png-bytes')
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE en-export SYSTEM "http://xml.evernote.com/pub/evernote-export4.dtd">
<en-export export-date="20261117T013000Z" application="Evernote" version="11.41.7">
  <note>
    <title>Soup</title>
    <created>20160304T050607Z</created>
    <updated>20170102T030405Z</updated>
    <tag>dinner</tag><tag>winter</tag>
    <note-attributes><source-url>https://example.com/soup</source-url></note-attributes>
    <content><![CDATA[${enml('<div>Hello</div>')}]]></content>
    <resource><data encoding="base64">${data.slice(0, 4)}
${data.slice(4)}</data><mime>image/png</mime><resource-attributes><file-name>a.png</file-name></resource-attributes></resource>
  </note>
</en-export>`
    const [note] = parseEnex(xml)
    expect(note.title).toBe('Soup')
    expect(note.createdAt).toBe(Date.UTC(2016, 2, 4, 5, 6, 7))
    expect(note.updatedAt).toBe(Date.UTC(2017, 0, 2, 3, 4, 5))
    expect(note.tags).toEqual(['dinner', 'winter'])
    expect(note.sourceUrl).toBe('https://example.com/soup')
    expect(new TextDecoder().decode(note.resources[0].bytes)).toBe('png-bytes')
    expect(note.resources[0]).toMatchObject({ mime: 'image/png', fileName: 'a.png' })
    expect(note.content).toContain('<en-note>')
  })

  it('rejects files that are not exports', () => {
    expect(() => parseEnex('<html></html>')).toThrow(/Evernote export/)
  })

  it('parses ENEX dates and notebook names', () => {
    expect(parseEnexDate('20260622T075058Z')).toBe(Date.UTC(2026, 5, 22, 7, 50, 58))
    expect(parseEnexDate('garbage')).toBeNull()
    expect(notebookNameFromFile('Recipes (55 notes).enex')).toBe('Recipes')
    expect(notebookNameFromFile('Serial Numbers (1 note).enex')).toBe('Serial Numbers')
  })
})

describe('ENML conversion', () => {
  it('turns divs into paragraphs and <div><br/></div> into empty paragraphs', () => {
    const { json } = convert('<div>One</div><div><br/></div><div>Two<br/></div>')
    expect(blocks(json).map((b) => [b.type, textOf(b)])).toEqual([
      ['paragraph', 'One'],
      ['paragraph', ''],
      ['paragraph', 'Two'],
    ])
  })

  it('turns Evernote indent blockquotes into indent levels', () => {
    const q = (inner: string) => `<blockquote style="margin: 0 0 0 40px; border: none; padding: 0px;">${inner}</blockquote>`
    const { json } = convert(`<div>zero</div>${q(`<div>one</div>${q('<div>two</div>')}`)}${q('bare text')}`)
    expect(blocks(json).map((b) => [textOf(b), b.attrs?.indent])).toEqual([
      ['zero', 0],
      ['one', 1],
      ['two', 2],
      ['bare text', 1],
    ])
  })

  it('keeps real blockquotes', () => {
    const { json } = convert('<blockquote style="border-left: 3px solid #ccc; margin-left: 10px;"><div>quoted</div></blockquote>')
    expect(blocks(json)[0].type).toBe('blockquote')
  })

  it('converts legacy en-todo checklists', () => {
    const { json, stats } = convert('<div><en-todo checked="true"/>Done</div><div><en-todo checked="false"/>Open</div><div>After</div>')
    const [list, after] = blocks(json)
    expect(list.type).toBe('taskList')
    expect(list.content!.map((li) => [li.attrs?.checked, textOf(li)])).toEqual([
      [true, 'Done'],
      [false, 'Open'],
    ])
    expect(textOf(after)).toBe('After')
    expect(stats.checklistItems).toBe(2)
  })

  it('converts current --en-todo checklists', () => {
    const { json } = convert(
      '<ul style="--en-todo:true;"><li style="--en-checked:true;"><div>Milk</div></li><li style="--en-checked:false;">Eggs</li></ul>',
    )
    const list = blocks(json)[0]
    expect(list.type).toBe('taskList')
    expect(list.content!.map((li) => [li.attrs?.checked, textOf(li)])).toEqual([
      [true, 'Milk'],
      [false, 'Eggs'],
    ])
  })

  it('keeps encrypted text as a locked block, out of the plain text', () => {
    const { json, text, stats } = convert('<div>Before</div><en-crypt hint="pet" cipher="AES" length="128">RU5DMIjE0Nz==</en-crypt>')
    const enc = blocks(json).find((b) => b.type === 'evernoteEncrypted')!
    expect(enc.attrs).toMatchObject({ cipher: 'AES', length: '128', hint: 'pet', data: 'RU5DMIjE0Nz==' })
    expect(text).not.toContain('RU5D')
    expect(stats.encrypted).toBe(1)
  })

  it('maps en-media to stored attachments by MD5 hash', () => {
    const bytes = new TextEncoder().encode('jpeg')
    const hash = bytesToHex(md5(bytes))
    const media = new Map([[hash, { ref: 'attachment:abc', mime: 'image/jpeg', fileName: 'photo.jpg' }]])
    const { json, stats } = convert(`<div>Photo:</div><en-media hash="${hash}" type="image/jpeg"/><div>after</div><en-media hash="ffff" type="image/png"/>`, media)
    const img = blocks(json).find((b) => b.type === 'image')
    expect(img?.attrs?.src).toBe('attachment:abc')
    expect(blocks(json).some((b) => textOf(b) === 'after')).toBe(true)
    expect(stats).toMatchObject({ images: 1, missingMedia: 1 })
    expect(blocks(json).some((b) => textOf(b).includes('missing from the Evernote export'))).toBe(true)
  })

  it('makes fully Courier paragraphs Monospaced and keeps mixed ones as font marks', () => {
    const { json } = convert(
      '<div><font face="Courier New">all mono</font></div><div><span style="font-family: courier new, monospace;">x</span> plain</div>',
    )
    const [mono, mixed] = blocks(json)
    expect(mono.attrs?.monospace).toBe(true)
    expect(JSON.stringify(mono)).not.toContain('Courier')
    expect(mixed.attrs?.monospace).toBe(false)
  })

  it('keeps tables, merged cells and formatting', () => {
    const { json, stats } = convert(
      '<table><tr><th>Item</th><th>Key</th></tr><tr><td colspan="2"><b>Wide</b></td></tr></table><div><font color="#c0392b">red</font></div>',
    )
    const table = blocks(json)[0]
    expect(table.type).toBe('table')
    expect(table.content![1].content![0].attrs?.colspan).toBe(2)
    expect(JSON.stringify(table)).toContain('"bold"')
    expect(JSON.stringify(blocks(json)[1])).toContain('#c0392b')
    expect(stats.tables).toBe(1)
  })

  it('maps black and near-black text to maximum contrast, keeping other colors', () => {
    const { json } = convert(
      '<div><font color="#000000">black</font> <span style="color: rgb(34, 34, 34)">dark gray</span> ' +
        '<span style="color: black">named</span> <span style="color: #1a237e">navy</span> ' +
        '<span style="color: #ffffff">white</span> <span style="color: #c0392b">red</span></div>',
    )
    const colors = blocks(json)[0].content!.filter((c) => c.text?.trim()).map((c) => [c.text, c.marks?.[0]?.attrs?.color])
    expect(colors).toEqual([
      ['black', CONTRAST_MAX],
      ['dark gray', CONTRAST_MAX],
      ['named', CONTRAST_MAX],
      ['navy', '#1a237e'],
      ['white', '#ffffff'],
      ['red', '#c0392b'],
    ])
  })

  it('classifies near-black neutrals only', () => {
    for (const c of ['#000', '#000000', 'black', '#1f1f1f', '#333333', 'rgb(64, 64, 64)']) expect(isNearBlack(c), c).toBe(true)
    for (const c of ['#444444', '#1a237e', '#3b0000', '#ffffff', 'red', 'var(--note-max, #000000)']) expect(isNearBlack(c), c).toBe(false)
  })

  it('produces a Yjs body that restores the same document', () => {
    const { body, text } = convert('<div>Hello <b>world</b></div>')
    const doc = new Y.Doc()
    Y.applyUpdate(doc, body)
    expect(doc.getXmlFragment('body').toString()).toContain('world')
    expect(text).toBe('Hello world')
  })
})

describe('importNotes', () => {
  let store: NoteStore

  beforeEach(async () => {
    const db = new DatabaseSync(':memory:')
    const driver: SqlDriver = {
      async execute(sql, params = []) {
        db.prepare(sql).run(...(params as never[]))
      },
      async select<T>(sql: string, params: unknown[] = []) {
        return db.prepare(sql).all(...(params as never[])) as T[]
      },
    }
    const files = new Map<string, Uint8Array>()
    const blobs: BlobStore = {
      has: async (h) => files.has(h),
      put: async (h, b) => void files.set(h, b),
      url: (h) => `blob:${h}`,
    }
    store = new NoteStore(driver, blobs)
    await store.migrate()
  })

  it('imports into a notebook with flat tags, original dates and attachments, and skips re-imports', async () => {
    const bytes = new TextEncoder().encode('img')
    const notes = [
      {
        title: 'Soup', createdAt: 1_400_000_000_000, updatedAt: 1_500_000_000_000, tags: ['dinner', 'home/kitchen'],
        content: enml(`<div>Simmer</div><en-media hash="${bytesToHex(md5(bytes))}" type="image/png"/>`),
        resources: [{ bytes, mime: 'image/png', fileName: 'soup.png', width: 40, height: 20 }], sourceUrl: null,
      },
      { title: '', createdAt: null, updatedAt: 1_450_000_000_000, tags: ['Dinner'], content: enml('<div>untitled</div>'), resources: [], sourceUrl: null },
    ]
    const progress: number[] = []
    const report = await importNotes(store, notes, { notebookName: 'Recipes', onProgress: (d) => progress.push(d) })
    expect(report).toMatchObject({ notebookName: 'Recipes', total: 2, imported: 2, skippedDuplicates: 0, failed: [] })
    expect(report.totals.images).toBe(1)
    expect(progress).toEqual([1, 2])

    const tags = await store.listTags()
    expect(tags.map((t) => t.name).sort()).toEqual(['dinner', 'home/kitchen'])
    expect(tags.every((t) => t.parentId === null)).toBe(true)

    const listed = await store.queryNotes({ notebookId: report.notebookId, sort: 'title' })
    expect(listed.map((n) => n.title)).toEqual(['Soup', 'Untitled'])
    expect(listed[0]).toMatchObject({ createdAt: 1_400_000_000_000, updatedAt: 1_500_000_000_000, snippet: 'Simmer' })
    expect(listed[1].createdAt).toBe(1_450_000_000_000)
    expect((await store.queryNotes({ text: 'simmer' })).length).toBe(1)

    const again = await importNotes(store, notes, { notebookName: 'recipes' })
    expect(again).toMatchObject({ imported: 0, skippedDuplicates: 2, notebookId: report.notebookId })
  })
})
