import { Extension } from '@tiptap/core'
import { MONOSPACE_FONT } from '../formatting'

// "Monospaced" paragraph style: normal rich text (marks, indent) in a predefined
// fixed-width font. Unlike a code block it keeps formatting. Enter continues the style.

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    monospace: {
      setMonospace: () => ReturnType
      unsetMonospace: () => ReturnType
    }
  }
}

const MONO_FAMILY = /mono|courier|consolas|menlo|monaco/i

export const Monospace = Extension.create({
  name: 'monospace',

  addGlobalAttributes() {
    return [
      {
        types: ['paragraph'],
        attributes: {
          monospace: {
            default: false,
            // Also recognizes fixed-width paragraphs in pasted HTML and Evernote ENML.
            parseHTML: (el) => el.hasAttribute('data-monospace') || MONO_FAMILY.test(el.style.fontFamily || ''),
            renderHTML: (attrs) =>
              attrs.monospace ? { 'data-monospace': '', style: `font-family: ${MONOSPACE_FONT}` } : {},
          },
        },
      },
    ]
  },

  addCommands() {
    return {
      setMonospace:
        () =>
        ({ chain }) =>
          chain().setParagraph().updateAttributes('paragraph', { monospace: true }).run(),
      unsetMonospace:
        () =>
        ({ commands }) =>
          commands.updateAttributes('paragraph', { monospace: false }),
    }
  },
})
