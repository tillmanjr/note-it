import type { Extensions } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { TableKit } from '@tiptap/extension-table'
import Image from '@tiptap/extension-image'
import { TextStyleKit } from '@tiptap/extension-text-style'
import TextAlign from '@tiptap/extension-text-align'
import Highlight from '@tiptap/extension-highlight'
import { CanonicalBackgroundColor, CanonicalColor } from './extensions/colors'
import { Indent } from './extensions/indent'
import { Paste, type PasteOptions } from './extensions/paste'

// The note schema. Shared by the live editor and the headless round-trip check.
export function noteExtensions(paste: PasteOptions = {}): Extensions {
  return [
    StarterKit.configure({
      link: { openOnClick: false, autolink: true, defaultProtocol: 'https' },
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
    Paste.configure(paste),
  ]
}
