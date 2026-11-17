import { useEditorState, type Editor } from '@tiptap/react'
import { BlockStyleSelect } from './BlockStyleSelect'
import { COLORS, FONTS, HIGHLIGHTS, SIZES } from './formatting'

// Main formatting toolbar.
export function Toolbar({ editor }: { editor: Editor }) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      underline: e.isActive('underline'),
      strike: e.isActive('strike'),
      highlight: e.isActive('highlight'),
      code: e.isActive('code'),
      link: e.isActive('link'),
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      task: e.isActive('taskList'),
      table: e.isActive('table'),
      left: e.isActive({ textAlign: 'left' }),
      center: e.isActive({ textAlign: 'center' }),
      right: e.isActive({ textAlign: 'right' }),
      font: (e.getAttributes('textStyle').fontFamily as string) ?? '',
      size: (e.getAttributes('textStyle').fontSize as string) ?? '',
    }),
  })

  const c = () => editor.chain().focus()
  const btn = (label: string, active: boolean, run: () => void, title?: string) => (
    <button className={active ? 'active' : ''} onMouseDown={(ev) => ev.preventDefault()} onClick={run} title={title ?? label}>
      {label}
    </button>
  )

  const setLink = () => {
    const prev = editor.getAttributes('link').href as string | undefined
    const url = window.prompt('Link URL (empty to remove)', prev ?? 'https://')
    if (url === null) return
    if (url === '') c().extendMarkRange('link').unsetLink().run()
    else c().extendMarkRange('link').setLink({ href: url }).run()
  }

  return (
    <div className="toolbar">
      <div className="group">
        {btn('↶', false, () => c().undo().run(), 'Undo')}
        {btn('↷', false, () => c().redo().run(), 'Redo')}
      </div>
      <div className="group">
        <select value={s.font} onChange={(e) => (e.target.value ? c().setFontFamily(e.target.value).run() : c().unsetFontFamily().run())}>
          {FONTS.map((f) => <option key={f} value={f}>{f || 'Font'}</option>)}
        </select>
        <select value={s.size} onChange={(e) => (e.target.value ? c().setFontSize(e.target.value).run() : c().unsetFontSize().run())}>
          {SIZES.map((z) => <option key={z} value={z}>{z || 'Size'}</option>)}
        </select>
      </div>
      <div className="group">
        {btn('B', s.bold, () => c().toggleBold().run(), 'Bold (Ctrl+B)')}
        {btn('I', s.italic, () => c().toggleItalic().run(), 'Italic (Ctrl+I)')}
        {btn('U', s.underline, () => c().toggleUnderline().run(), 'Underline (Ctrl+U)')}
        {btn('S', s.strike, () => c().toggleStrike().run(), 'Strikethrough')}
        {btn('</>', s.code, () => c().toggleCode().run(), 'Inline code')}
        {btn('🔗', s.link, setLink, 'Link')}
      </div>
      <div className="group swatches">
        {COLORS.map((col) => (
          <button key={col} className="swatch" style={{ background: col }} title={`Text ${col}`}
            onMouseDown={(ev) => ev.preventDefault()} onClick={() => c().setColor(col).run()} />
        ))}
        {HIGHLIGHTS.map((col) => (
          <button key={col} className="swatch hl" style={{ background: col }} title={`Highlight ${col}`}
            onMouseDown={(ev) => ev.preventDefault()} onClick={() => c().toggleHighlight({ color: col }).run()} />
        ))}
        {btn('⌫', false, () => c().unsetAllMarks().run(), 'Clear formatting')}
      </div>
      <div className="group">
        <BlockStyleSelect editor={editor} />
      </div>
      <div className="group">
        {btn('•', s.bullet, () => c().toggleBulletList().run(), 'Bulleted list')}
        {btn('1.', s.ordered, () => c().toggleOrderedList().run(), 'Numbered list')}
        {btn('☑', s.task, () => c().toggleTaskList().run(), 'Checklist')}
        {btn('⇤', false, () => (s.bullet || s.ordered || s.task ? c().liftListItem(s.task ? 'taskItem' : 'listItem').run() : c().outdent().run()), 'Outdent (Shift+Tab)')}
        {btn('⇥', false, () => (s.bullet || s.ordered || s.task ? c().sinkListItem(s.task ? 'taskItem' : 'listItem').run() : c().indent().run()), 'Indent (Tab)')}
      </div>
      <div className="group">
        {btn('⯇', s.left, () => c().setTextAlign('left').run(), 'Align left')}
        {btn('≡', s.center, () => c().setTextAlign('center').run(), 'Center')}
        {btn('⯈', s.right, () => c().setTextAlign('right').run(), 'Align right')}
      </div>
      <div className="group">
        {btn('―', false, () => c().setHorizontalRule().run(), 'Divider')}
        {btn('⊞', s.table, () => c().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(), 'Insert table')}
        {s.table && (
          <>
            {btn('+row', false, () => c().addRowAfter().run())}
            {btn('+col', false, () => c().addColumnAfter().run())}
            {btn('−row', false, () => c().deleteRow().run())}
            {btn('−col', false, () => c().deleteColumn().run())}
            {btn('✕tbl', false, () => c().deleteTable().run())}
          </>
        )}
      </div>
    </div>
  )
}
