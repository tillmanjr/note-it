import { generateJSON, generateText, getSchema, type JSONContent } from '@tiptap/core'
import { prosemirrorJSONToYDoc } from '@tiptap/y-tiptap'
import { md5 } from '@noble/hashes/legacy.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import * as Y from 'yjs'
import { attachmentRef, type Id, type NoteStore } from '@tdjr/core'
import { NOTE_BODY_FIELD, noteExtensions } from '@tdjr/editor'
import { enmlToHtml, type EnmlStats, type MediaRef } from './enml'
import { parseEnex, type EnexNote } from './parse'

export interface ConvertedNote {
  json: JSONContent
  /** Yjs update holding the body, ready for NoteStore.importNote. */
  body: Uint8Array
  text: string
  stats: EnmlStats
}

const extensions = noteExtensions()
const schema = getSchema(extensions)

/** ENML → editor JSON → Yjs body + plain text. Attachments must already be stored (see `media`). */
export function convertNote(enml: string, media: Map<string, MediaRef>): ConvertedNote {
  const { html, stats } = enmlToHtml(enml, media)
  const json = generateJSON(html, extensions)
  const ydoc = prosemirrorJSONToYDoc(schema, json, NOTE_BODY_FIELD)
  return {
    json,
    body: Y.encodeStateAsUpdate(ydoc),
    text: generateText(json, extensions, { blockSeparator: '\n\n' }),
    stats,
  }
}

export interface ImportOptions {
  /** Target notebook name; created if it doesn't exist (matched case-insensitively). */
  notebookName: string
  onProgress?: (done: number, total: number) => void
}

export interface ImportReport {
  notebookId: Id
  notebookName: string
  total: number
  imported: number
  skippedDuplicates: number
  failed: { title: string; error: string }[]
  /** Imported notes that need a look, e.g. attachments missing from the export. */
  warnings: { title: string; message: string }[]
  totals: EnmlStats
}

/** "Recipes (55 notes).enex" → "Recipes". */
export function notebookNameFromFile(fileName: string): string {
  return fileName.replace(/\.enex$/i, '').replace(/\s*\(\d+ notes?\)\s*$/i, '').trim() || 'Imported'
}

export function readEnex(xml: string): EnexNote[] {
  return parseEnex(xml)
}

/** Imports parsed notes into one notebook. Re-importing the same export skips notes already present. */
export async function importNotes(store: NoteStore, notes: EnexNote[], options: ImportOptions): Promise<ImportReport> {
  const notebook = await store.findOrCreateNotebook(options.notebookName)
  const totals: EnmlStats = { images: 0, files: 0, missingMedia: 0, checklistItems: 0, encrypted: 0, tables: 0, remoteImages: 0 }
  const report: ImportReport = {
    notebookId: notebook.id,
    notebookName: notebook.name,
    total: notes.length,
    imported: 0,
    skippedDuplicates: 0,
    failed: [],
    warnings: [],
    totals,
  }
  const tagIds = new Map<string, Id>()

  for (const [i, note] of notes.entries()) {
    const title = note.title || 'Untitled'
    try {
      const createdAt = note.createdAt ?? note.updatedAt ?? Date.now()
      const updatedAt = note.updatedAt ?? createdAt
      if (await store.findImportedNote(notebook.id, title, createdAt)) {
        report.skippedDuplicates++
      } else {
        const media = new Map<string, MediaRef>()
        for (const res of note.resources) {
          const key = bytesToHex(md5(res.bytes))
          if (res.mime.startsWith('image/') && (res.width ?? 2) <= 1 && (res.height ?? 2) <= 1) {
            media.set(key, { ref: '', mime: res.mime, fileName: res.fileName, spacer: true })
            continue
          }
          const att = await store.putAttachment(res.bytes, res.mime, res.fileName ?? 'attachment')
          media.set(key, { ref: attachmentRef(att.hash), mime: res.mime, fileName: res.fileName })
        }
        const converted = convertNote(note.content, media)
        const noteTagIds: Id[] = []
        for (const name of note.tags) {
          const key = name.toLowerCase()
          if (!tagIds.has(key)) tagIds.set(key, (await store.findOrCreateTag(name)).id)
          noteTagIds.push(tagIds.get(key)!)
        }
        await store.importNote({
          notebookId: notebook.id,
          title,
          createdAt,
          updatedAt,
          tagIds: noteTagIds,
          body: converted.body,
          text: converted.text,
        })
        for (const k of Object.keys(totals) as (keyof EnmlStats)[]) totals[k] += converted.stats[k]
        if (converted.stats.missingMedia) {
          const n = converted.stats.missingMedia
          report.warnings.push({ title, message: `${n} attachment${n > 1 ? 's' : ''} missing from the Evernote export` })
        }
        report.imported++
      }
    } catch (e) {
      report.failed.push({ title, error: e instanceof Error ? e.message : String(e) })
    }
    options.onProgress?.(i + 1, notes.length)
  }
  return report
}
