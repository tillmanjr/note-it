// Parses an Evernote export (.enex): notes with title, dates, tags, ENML content and resources.

export interface EnexResource {
  bytes: Uint8Array
  mime: string
  fileName: string | null
  width: number | null
  height: number | null
}

export interface EnexNote {
  title: string
  createdAt: number | null
  updatedAt: number | null
  tags: string[]
  /** ENML (XHTML with en-* elements). */
  content: string
  resources: EnexResource[]
  sourceUrl: string | null
}

/** ENEX timestamps look like 20260622T075058Z (UTC). */
export function parseEnexDate(value: string | null | undefined): number | null {
  const m = value?.trim().match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/)
  if (!m) return null
  const [, y, mo, d, h, mi, s] = m.map(Number)
  return Date.UTC(y, mo - 1, d, h, mi, s)
}

function decodeBase64(text: string): Uint8Array {
  const bin = atob(text.replace(/\s+/g, ''))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

const childText = (el: Element, name: string): string | null => {
  for (const c of Array.from(el.children)) if (c.tagName === name) return c.textContent
  return null
}

export function parseEnex(xml: string): EnexNote[] {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  const error = doc.getElementsByTagName('parsererror')[0]
  if (error) throw new Error(`Not a valid Evernote export: ${error.textContent?.slice(0, 200) ?? 'parse error'}`)
  const root = doc.documentElement
  if (root.tagName !== 'en-export') throw new Error('Not an Evernote export (missing <en-export>).')

  return Array.from(root.children)
    .filter((el) => el.tagName === 'note')
    .map((note) => {
      const children = Array.from(note.children)
      const attrs = children.find((c) => c.tagName === 'note-attributes')
      return {
        title: (childText(note, 'title') ?? '').trim(),
        createdAt: parseEnexDate(childText(note, 'created')),
        updatedAt: parseEnexDate(childText(note, 'updated')),
        tags: children.filter((c) => c.tagName === 'tag').map((t) => (t.textContent ?? '').trim()).filter(Boolean),
        content: childText(note, 'content') ?? '',
        sourceUrl: attrs ? childText(attrs, 'source-url') : null,
        resources: children
          .filter((c) => c.tagName === 'resource')
          .map((r) => {
            const ra = Array.from(r.children).find((c) => c.tagName === 'resource-attributes')
            return {
              bytes: decodeBase64(childText(r, 'data') ?? ''),
              mime: (childText(r, 'mime') ?? 'application/octet-stream').trim(),
              fileName: ra ? childText(ra, 'file-name') : null,
              width: Number(childText(r, 'width')) || null,
              height: Number(childText(r, 'height')) || null,
            }
          }),
      }
    })
}
