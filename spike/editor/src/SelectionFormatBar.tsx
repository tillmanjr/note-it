import { useEffect, useRef } from 'react'
import { useEditorState, type Editor } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import { COLORS, HIGHLIGHTS } from './formatting'

const PLUGIN_KEY = 'selectionFormatBar'

type BlockStyle = 'paragraph' | 'h1' | 'h2' | 'h3' | 'code'

const BLOCK_STYLES: { value: BlockStyle; label: string }[] = [
  { value: 'paragraph', label: 'Normal Text' },
  { value: 'h1', label: 'H1' },
  { value: 'h2', label: 'H2' },
  { value: 'h3', label: 'H3' },
  { value: 'code', label: 'Code' },
]

// A compact format bar shown above the selection when the user right-clicks inside it.
// The style dropdown applies paragraph / heading / code block to the touched blocks.
// It stays open while formats are applied and closes when the selection changes, on
// Escape, or when focus leaves. Shift+right-click keeps the native context menu.
export function SelectionFormatBar({ editor }: { editor: Editor }) {
  // The selection the bar was opened for; null while closed.
  const armed = useRef<{ from: number; to: number } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const dom = editor.view.dom
    const close = () => {
      if (!armed.current) return
      armed.current = null
      editor.view.dispatch(editor.state.tr.setMeta(PLUGIN_KEY, 'hide'))
    }
    const onContextMenu = (e: MouseEvent) => {
      if (e.shiftKey) return
      const { from, to, empty } = editor.state.selection
      if (empty) return
      const hit = editor.view.posAtCoords({ left: e.clientX, top: e.clientY })
      if (!hit || hit.pos < from || hit.pos > to) return
      e.preventDefault()
      armed.current = { from, to }
      editor.view.dispatch(editor.state.tr.setMeta(PLUGIN_KEY, 'show'))
      // 'show' positions the bar before attaching it to the DOM; position again once attached.
      editor.view.dispatch(editor.state.tr.setMeta(PLUGIN_KEY, 'updatePosition'))
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && armed.current) {
        e.preventDefault()
        close()
        editor.commands.focus()
      }
    }
    const onFocusOut = (e: FocusEvent) => {
      const next = e.relatedTarget as Node | null
      if (next && (dom.contains(next) || menuRef.current?.contains(next))) return
      close()
    }
    const menu = menuRef.current
    dom.addEventListener('contextmenu', onContextMenu)
    dom.addEventListener('keydown', onKeyDown)
    dom.addEventListener('focusout', onFocusOut)
    menu?.addEventListener('keydown', onKeyDown)
    menu?.addEventListener('focusout', onFocusOut)
    return () => {
      dom.removeEventListener('contextmenu', onContextMenu)
      dom.removeEventListener('keydown', onKeyDown)
      dom.removeEventListener('focusout', onFocusOut)
      menu?.removeEventListener('keydown', onKeyDown)
      menu?.removeEventListener('focusout', onFocusOut)
    }
  }, [editor])

  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      code: e.isActive('code'),
      block: (e.isActive('codeBlock')
        ? 'code'
        : e.isActive('heading', { level: 1 })
          ? 'h1'
          : e.isActive('heading', { level: 2 })
            ? 'h2'
            : e.isActive('heading', { level: 3 })
              ? 'h3'
              : 'paragraph') as BlockStyle,
      color: (e.getAttributes('textStyle').color as string) ?? '',
      highlight: (e.getAttributes('highlight').color as string) ?? '',
    }),
  })

  const c = () => editor.chain().focus()
  const keepSelection = (ev: React.MouseEvent) => ev.preventDefault()

  // Block styles apply to the whole block(s) the selection touches, as in Evernote.
  const setBlock = (block: BlockStyle) => {
    switch (block) {
      case 'paragraph':
        return c().setParagraph().run()
      case 'code':
        return c().setCodeBlock().run()
      default:
        return c().setHeading({ level: Number(block[1]) as 1 | 2 | 3 }).run()
    }
  }

  return (
    <BubbleMenu
      ref={menuRef}
      editor={editor}
      pluginKey={PLUGIN_KEY}
      className="format-bar"
      options={{ placement: 'top', offset: 8, flip: true, shift: { padding: 8 } }}
      shouldShow={({ state }) => {
        const a = armed.current
        if (!a) return false
        if (state.selection.from !== a.from || state.selection.to !== a.to) {
          armed.current = null
          return false
        }
        return true
      }}
    >
      <select value={s.block} title="Text style" onChange={(e) => setBlock(e.target.value as BlockStyle)}>
        {BLOCK_STYLES.map((b) => (
          <option key={b.value} value={b.value}>
            {b.label}
          </option>
        ))}
      </select>
      <span className="sep" />
      <button className={s.bold ? 'active' : ''} title="Bold" onMouseDown={keepSelection} onClick={() => c().toggleBold().run()}>
        <b>B</b>
      </button>
      <button className={s.italic ? 'active' : ''} title="Italic" onMouseDown={keepSelection} onClick={() => c().toggleItalic().run()}>
        <i>I</i>
      </button>
      <button className={s.code ? 'active' : ''} title="Inline code" onMouseDown={keepSelection} onClick={() => c().toggleCode().run()}>
        {'</>'}
      </button>
      <span className="sep" />
      {COLORS.map((col) => (
        <button key={col} className={`swatch${s.color === col ? ' active' : ''}`} style={{ background: col }} title={`Text ${col}`}
          onMouseDown={keepSelection} onClick={() => c().setColor(col).run()} />
      ))}
      <button className="swatch none" title="Default text color" onMouseDown={keepSelection} onClick={() => c().unsetColor().run()} />
      <span className="sep" />
      {HIGHLIGHTS.map((col) => (
        <button key={col} className={`swatch hl${s.highlight === col ? ' active' : ''}`} style={{ background: col }} title={`Highlight ${col}`}
          onMouseDown={keepSelection} onClick={() => c().setHighlight({ color: col }).run()} />
      ))}
      <button className="swatch hl none" title="Remove highlight" onMouseDown={keepSelection} onClick={() => c().unsetHighlight().run()} />
    </BubbleMenu>
  )
}
