import { Extension, type CommandProps } from '@tiptap/core'
import type { EditorState, Transaction } from '@tiptap/pm/state'

// Real block indentation (Evernote-style), stored as a numeric `indent`
// attribute on block nodes instead of blockquote/nbsp hacks.

export interface IndentOptions {
  types: string[]
  maxLevel: number
  /** CSS pixels per level when rendering and when inferring levels from pasted HTML. */
  stepPx: number
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    indent: {
      indent: () => ReturnType
      outdent: () => ReturnType
    }
  }
}

const LIST_ITEM_TYPES = ['listItem', 'taskItem']

function parseLength(value: string): number {
  const m = value.trim().match(/^(-?[\d.]+)(px|em|rem|pt)?$/)
  if (!m) return 0
  const n = parseFloat(m[1])
  switch (m[2]) {
    case 'em':
    case 'rem':
      return n * 16
    case 'pt':
      return (n * 4) / 3
    default:
      return n
  }
}

function inListItem(state: EditorState): boolean {
  const { $from } = state.selection
  for (let d = $from.depth; d > 0; d--) {
    if (LIST_ITEM_TYPES.includes($from.node(d).type.name)) return true
  }
  return false
}

function inTable(state: EditorState): boolean {
  const { $from } = state.selection
  for (let d = $from.depth; d > 0; d--) {
    const name = $from.node(d).type.name
    if (name === 'tableCell' || name === 'tableHeader') return true
  }
  return false
}

export const Indent = Extension.create<IndentOptions>({
  name: 'indent',

  // Run after list/table keymaps so they get first claim on Tab.
  priority: 25,

  addOptions() {
    return { types: ['paragraph', 'heading', 'codeBlock'], maxLevel: 12, stepPx: 40 }
  },

  addGlobalAttributes() {
    const { stepPx, maxLevel } = this.options
    return [
      {
        types: this.options.types,
        attributes: {
          indent: {
            default: 0,
            parseHTML: (el) => {
              const explicit = el.getAttribute('data-indent')
              if (explicit) return Math.min(maxLevel, parseInt(explicit, 10) || 0)
              // Pasted content (Evernote ENML, Google Docs, Word) expresses indents as margin/padding.
              const px = Math.max(parseLength(el.style.marginLeft || ''), parseLength(el.style.paddingLeft || ''))
              return Math.min(maxLevel, Math.max(0, Math.round(px / stepPx)))
            },
            renderHTML: (attrs) =>
              attrs.indent > 0
                ? { 'data-indent': attrs.indent, style: `margin-left: ${attrs.indent * stepPx}px` }
                : {},
          },
        },
      },
    ]
  },

  addCommands() {
    const shift =
      (delta: number) =>
      ({ tr, state, dispatch }: CommandProps) => {
        const { from, to } = state.selection
        let changed = false
        state.doc.nodesBetween(from, to, (node, pos) => {
          if (!this.options.types.includes(node.type.name)) return true
          const next = Math.min(this.options.maxLevel, Math.max(0, (node.attrs.indent ?? 0) + delta))
          if (next !== node.attrs.indent) {
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, indent: next })
            changed = true
          }
          return false
        })
        if (changed && dispatch) dispatch(tr as Transaction)
        return changed
      }
    return { indent: () => shift(1), outdent: () => shift(-1) }
  },

  addKeyboardShortcuts() {
    return {
      Tab: ({ editor }) => {
        if (inTable(editor.state)) return false
        // List items are nested by the list extensions; if they declined (e.g. first item), keep focus in the editor.
        if (inListItem(editor.state)) return true
        editor.commands.indent()
        return true
      },
      'Shift-Tab': ({ editor }) => {
        if (inTable(editor.state)) return false
        if (inListItem(editor.state)) return true
        editor.commands.outdent()
        return true
      },
      Backspace: ({ editor }) => {
        // Backspace at the very start of an indented block outdents it, like word processors do.
        const { selection } = editor.state
        const { $from, empty } = selection
        if (!empty || $from.parentOffset !== 0) return false
        const node = $from.parent
        if (!this.options.types.includes(node.type.name) || !(node.attrs.indent > 0)) return false
        return editor.commands.outdent()
      },
    }
  },
})
