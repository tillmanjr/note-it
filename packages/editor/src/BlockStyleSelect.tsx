import { useEditorState, type Editor } from '@tiptap/react'

export type BlockStyle = 'paragraph' | 'mono' | 'h1' | 'h2' | 'h3' | 'code'

const BLOCK_STYLES: { value: BlockStyle; label: string }[] = [
  { value: 'paragraph', label: 'Normal Text' },
  { value: 'mono', label: 'Monospaced' },
  { value: 'h1', label: 'Heading Large' },
  { value: 'h2', label: 'Heading Medium' },
  { value: 'h3', label: 'Heading Small' },
  { value: 'code', label: 'Code' },
]

// Text style dropdown shared by the main toolbar and the selection format bar.
// Styles apply to the whole block(s) the selection touches, as in Evernote.
export function BlockStyleSelect({ editor }: { editor: Editor }) {
  const current = useEditorState({
    editor,
    selector: ({ editor: e }): BlockStyle => {
      if (e.isActive('codeBlock')) return 'code'
      for (const level of [1, 2, 3] as const) if (e.isActive('heading', { level })) return `h${level}`
      if (e.isActive('paragraph', { monospace: true })) return 'mono'
      return 'paragraph'
    },
  })

  const apply = (style: BlockStyle) => {
    const c = editor.chain().focus()
    switch (style) {
      case 'paragraph':
        return c.setParagraph().unsetMonospace().run()
      case 'mono':
        return c.setMonospace().run()
      case 'code':
        return c.setCodeBlock().run()
      default:
        return c.setHeading({ level: Number(style[1]) as 1 | 2 | 3 }).run()
    }
  }

  return (
    <select value={current} title="Text style" onChange={(e) => apply(e.target.value as BlockStyle)}>
      {BLOCK_STYLES.map((b) => (
        <option key={b.value} value={b.value}>
          {b.label}
        </option>
      ))}
    </select>
  )
}
