import { useEditorState, type Editor } from '@tiptap/react'
import { Dropdown, DropdownItem } from './Dropdown'
import { COLORS, FONTS, HIGHLIGHTS, SIZES, colorLabel } from './formatting'

// Compact toolbar menus: each is one narrow button that opens a small panel.

/** Text color: the current color under an "A"; the panel holds the swatches and Default. */
export function TextColorMenu({ editor }: { editor: Editor }) {
  const color = useEditorState({ editor, selector: ({ editor: e }) => (e.getAttributes('textStyle').color as string) ?? '' })
  const c = () => editor.chain().focus()
  return (
    <Dropdown
      className="color-menu"
      title="Text color"
      label={
        <span className="color-glyph">
          A<span className="color-bar" style={{ background: color || 'var(--note-max, currentColor)' }} />
        </span>
      }
    >
      {(close) => (
        <div className="swatch-grid">
          {COLORS.map((col) => (
            <button
              key={col}
              className={`swatch${color === col ? ' active' : ''}`}
              style={{ background: col }}
              title={colorLabel(col)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => (c().setColor(col).run(), close())}
            />
          ))}
          <DropdownItem active={!color} onSelect={() => (c().unsetColor().run(), close())}>
            Default
          </DropdownItem>
        </div>
      )}
    </Dropdown>
  )
}

/** Highlight: the current highlight under a marker; the panel holds None and the colors. */
export function HighlightMenu({ editor }: { editor: Editor }) {
  const highlight = useEditorState({
    editor,
    selector: ({ editor: e }) => (e.isActive('highlight') ? ((e.getAttributes('highlight').color as string) ?? HIGHLIGHTS[0]) : ''),
  })
  const c = () => editor.chain().focus()
  return (
    <Dropdown
      className="color-menu"
      title="Highlight"
      label={
        <span className="color-glyph">
          <span className="marker">ab</span>
          <span className={`color-bar${highlight ? '' : ' none'}`} style={highlight ? { background: highlight } : undefined} />
        </span>
      }
    >
      {(close) => (
        <div className="swatch-grid">
          {HIGHLIGHTS.map((col) => (
            <button
              key={col}
              className={`swatch hl${highlight === col ? ' active' : ''}`}
              style={{ background: col }}
              title={`Highlight ${col}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => (c().setHighlight({ color: col }).run(), close())}
            />
          ))}
          <DropdownItem active={!highlight} onSelect={() => (c().unsetHighlight().run(), close())}>
            None
          </DropdownItem>
        </div>
      )}
    </Dropdown>
  )
}

type ListKind = 'bullet' | 'ordered' | 'task' | ''

const LISTS: { kind: Exclude<ListKind, ''>; icon: string; label: string }[] = [
  { kind: 'bullet', icon: '•', label: 'Bulleted list' },
  { kind: 'ordered', icon: '1.', label: 'Numbered list' },
  { kind: 'task', icon: '☑', label: 'Checklist' },
]

/** Lists: shows the current list type; picking the active one turns the list off. */
export function ListMenu({ editor }: { editor: Editor }) {
  const kind = useEditorState({
    editor,
    selector: ({ editor: e }): ListKind =>
      e.isActive('taskList') ? 'task' : e.isActive('orderedList') ? 'ordered' : e.isActive('bulletList') ? 'bullet' : '',
  })
  const toggle = (k: Exclude<ListKind, ''>) => {
    const c = editor.chain().focus()
    if (k === 'bullet') c.toggleBulletList().run()
    else if (k === 'ordered') c.toggleOrderedList().run()
    else c.toggleTaskList().run()
  }
  const current = LISTS.find((l) => l.kind === kind)
  return (
    <Dropdown className="list-menu" title={current ? current.label : 'List'} active={!!current} label={<span className="list-icon">{current?.icon ?? '☰'}</span>}>
      {(close) => (
        <>
          {LISTS.map((l) => (
            <DropdownItem key={l.kind} active={l.kind === kind} onSelect={() => (toggle(l.kind), close())}>
              <span className="item-icon">{l.icon}</span> {l.label}
            </DropdownItem>
          ))}
          {current && (
            <DropdownItem onSelect={() => (toggle(current.kind), close())}>
              <span className="item-icon" /> No list
            </DropdownItem>
          )}
        </>
      )}
    </Dropdown>
  )
}

/** Font face and size behind one "Aa" button. */
export function FontMenu({ editor }: { editor: Editor }) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      font: (e.getAttributes('textStyle').fontFamily as string) ?? '',
      size: (e.getAttributes('textStyle').fontSize as string) ?? '',
    }),
  })
  const c = () => editor.chain().focus()
  return (
    <Dropdown className="font-menu" title="Font and size" active={!!(s.font || s.size)} label={<span className="font-glyph">Aa</span>}>
      {() => (
        <div className="font-fields">
          <label>
            Font
            <select value={s.font} onChange={(e) => (e.target.value ? c().setFontFamily(e.target.value).run() : c().unsetFontFamily().run())}>
              {FONTS.map((f) => (
                <option key={f} value={f} style={f ? { fontFamily: f } : undefined}>
                  {f || 'Default'}
                </option>
              ))}
            </select>
          </label>
          <label>
            Size
            <select value={s.size} onChange={(e) => (e.target.value ? c().setFontSize(e.target.value).run() : c().unsetFontSize().run())}>
              {SIZES.map((z) => (
                <option key={z} value={z}>
                  {z || 'Default'}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
    </Dropdown>
  )
}
