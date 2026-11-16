import { useMemo, useState } from 'react'
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react'
import { generateJSON, type JSONContent } from '@tiptap/core'
import { canonicalize } from './canonical'
import { noteExtensions } from './editorExtensions'
import { SAMPLE_NOTE } from './sample'
import { COLORS, FONTS, HIGHLIGHTS, SIZES } from './formatting'
import { SelectionFormatBar } from './SelectionFormatBar'
import './App.css'

// Spike-only persistence; the real app stores Yjs documents in SQLite.
const STORAGE_KEY = 'tdjr-spike-note'

function loadSaved(): JSONContent | string {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw) as JSONContent
  } catch {
    // fall through to sample
  }
  return SAMPLE_NOTE
}

function save(json: JSONContent) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(json))
  } catch {
    // storage unavailable or full (large pasted images); spike ignores
  }
}

export default function App() {
  const [rawPaste, setRawPaste] = useState('')
  const [showDebug, setShowDebug] = useState(false)
  const [roundTrip, setRoundTrip] = useState<string | null>(null)

  const extensions = useMemo(() => noteExtensions({ onRawHtml: setRawPaste }), [])

  const editor = useEditor({
    extensions,
    content: loadSaved(),
    autofocus: 'end',
    onUpdate: ({ editor }) => save(canonicalize(editor.getJSON())),
  })

  const checkRoundTrip = () => {
    // JSON -> HTML -> JSON must be lossless: HTML is the export/clipboard format.
    const before = canonicalize(editor.getJSON())
    const after = canonicalize(generateJSON(editor.getHTML(), noteExtensions()))
    const a = JSON.stringify(before)
    const b = JSON.stringify(after)
    if (a === b) {
      setRoundTrip('✓ Lossless: JSON → HTML → JSON is identical.')
    } else {
      let i = 0
      while (i < a.length && a[i] === b[i]) i++
      setRoundTrip(`✗ Differs at char ${i}:\nbefore: …${a.slice(Math.max(0, i - 80), i + 120)}\nafter:  …${b.slice(Math.max(0, i - 80), i + 120)}`)
    }
    setShowDebug(true)
  }

  const resetSample = () => {
    editor.commands.setContent(SAMPLE_NOTE)
    save(canonicalize(editor.getJSON()))
  }

  return (
    <div className="app">
      <Toolbar editor={editor} />
      <div className="spike-actions">
        <button onClick={() => setShowDebug((v) => !v)}>{showDebug ? 'Hide' : 'Show'} debug</button>
        <button onClick={checkRoundTrip}>Check HTML round-trip</button>
        <button onClick={resetSample}>Reset to sample</button>
      </div>
      <div className={showDebug ? 'layout with-debug' : 'layout'}>
        <div className="note">
          <EditorContent editor={editor} />
          <SelectionFormatBar editor={editor} />
        </div>
        {showDebug && <DebugPane editor={editor} rawPaste={rawPaste} roundTrip={roundTrip} />}
      </div>
    </div>
  )
}

function DebugPane({ editor, rawPaste, roundTrip }: { editor: Editor; rawPaste: string; roundTrip: string | null }) {
  const json = useEditorState({ editor, selector: ({ editor }) => JSON.stringify(editor.getJSON(), null, 2) })
  return (
    <aside className="debug">
      {roundTrip && (
        <>
          <h3>Round-trip</h3>
          <pre className={roundTrip.startsWith('✓') ? 'ok' : 'bad'}>{roundTrip}</pre>
        </>
      )}
      <h3>Document (JSON)</h3>
      <pre>{json}</pre>
      <h3>Last raw pasted HTML</h3>
      <pre>{rawPaste || '(nothing pasted yet)'}</pre>
    </aside>
  )
}

function Toolbar({ editor }: { editor: Editor }) {
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
      h1: e.isActive('heading', { level: 1 }),
      h2: e.isActive('heading', { level: 2 }),
      h3: e.isActive('heading', { level: 3 }),
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      task: e.isActive('taskList'),
      codeBlock: e.isActive('codeBlock'),
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
        {btn('H1', s.h1, () => c().toggleHeading({ level: 1 }).run())}
        {btn('H2', s.h2, () => c().toggleHeading({ level: 2 }).run())}
        {btn('H3', s.h3, () => c().toggleHeading({ level: 3 }).run())}
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
        {btn('{ }', s.codeBlock, () => c().toggleCodeBlock().run(), 'Code block')}
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
