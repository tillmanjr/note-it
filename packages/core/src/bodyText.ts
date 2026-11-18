import * as Y from 'yjs'

/** Yjs fragment holding a note body (the editor's Collaboration field; see @tdjr/editor NOTE_BODY_FIELD). */
export const BODY_FIELD = 'body'

const SNIPPET_LENGTH = 200

/** The note-list snippet for a body's plain text. */
export const snippetOf = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_LENGTH)

/**
 * Plain text of a note body, for search and the list snippet when no editor is open (e.g. a change synced
 * from another device). Blocks are separated by newlines; formatting is dropped.
 */
export function bodyText(update: Uint8Array): string {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, update)
  const parts: string[] = []
  const walk = (node: Y.XmlElement | Y.XmlFragment | Y.XmlText) => {
    if (node instanceof Y.XmlText) {
      for (const op of node.toDelta() as { insert: unknown }[]) if (typeof op.insert === 'string') parts.push(op.insert)
      return
    }
    for (const child of node.toArray()) {
      walk(child as Y.XmlElement | Y.XmlText)
      if (child instanceof Y.XmlElement) parts.push('\n')
    }
  }
  walk(doc.getXmlFragment(BODY_FIELD))
  return parts.join('').replace(/\n{3,}/g, '\n\n').trim()
}
