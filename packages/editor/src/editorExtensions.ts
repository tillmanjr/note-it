import type { Extensions } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { TableKit } from '@tiptap/extension-table'
import Image from '@tiptap/extension-image'
import { TextStyleKit } from '@tiptap/extension-text-style'
import TextAlign from '@tiptap/extension-text-align'
import Highlight from '@tiptap/extension-highlight'
import Collaboration from '@tiptap/extension-collaboration'
import type { Doc } from 'yjs'
import { CanonicalBackgroundColor, CanonicalColor } from './extensions/colors'
import { Indent } from './extensions/indent'
import { Monospace } from './extensions/monospace'
import { Paste, type PasteOptions } from './extensions/paste'

/** Yjs fragment holding a note body inside its Y.Doc. */
export const NOTE_BODY_FIELD = 'body'

export interface NoteExtensionOptions {
  paste?: PasteOptions
  /** When set, the body lives in this Y.Doc (undo/redo come from Yjs). */
  ydoc?: Doc
}

// The note schema. Shared by the live editor and headless conversions (import/export, round-trip checks).
export function noteExtensions({ paste = {}, ydoc }: NoteExtensionOptions = {}): Extensions {
  return [
    StarterKit.configure({
      link: { openOnClick: false, autolink: true, defaultProtocol: 'https' },
      // Yjs supplies its own undo manager.
      undoRedo: ydoc ? false : undefined,
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit.configure({ table: { resizable: true } }),
    Image.configure({ allowBase64: true }),
    TextStyleKit.configure({ color: false, backgroundColor: false }),
    CanonicalColor,
    CanonicalBackgroundColor,
    Highlight.configure({ multicolor: true }),
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    Indent,
    Monospace,
    Paste.configure(paste),
    ...(ydoc ? [Collaboration.configure({ document: ydoc, field: NOTE_BODY_FIELD })] : []),
  ]
}
