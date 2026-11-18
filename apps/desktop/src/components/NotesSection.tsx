import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Id, NoteMeta, NoteSort, Notebook } from '@tdjr/core'
import { NoteList } from './NoteList'
import { Section } from './Section'

/** Where the notes list lives: in the left pane, or in a strip above the editor. */
export type NotesPlacement = 'left' | 'top'

const PLACEMENT_KEY = 'tdjr.notesPlacement'
const HEIGHT_KEY = 'tdjr.notesHeight'
const DEFAULT_HEIGHT = 240
const MIN_LIST = 80
const MIN_EDITOR = 160

function load(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function save(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // storage unavailable: the layout still works for this session
  }
}

/** The notes-list placement, remembered per device (a UI convenience only). */
export function useNotesPlacement(): [NotesPlacement, (p: NotesPlacement) => void] {
  const [placement, setPlacement] = useState<NotesPlacement>(() => (load(PLACEMENT_KEY) === 'top' ? 'top' : 'left'))
  return [
    placement,
    (p) => {
      save(PLACEMENT_KEY, p)
      setPlacement(p)
    },
  ]
}

export function NotesSection({
  notes,
  notebooks,
  viewTitle,
  inTrash,
  sort,
  selectedId,
  placement,
  collapsed,
  onToggle,
  onSort,
  onSelect,
  onPlacement,
}: {
  notes: NoteMeta[]
  notebooks: Notebook[]
  viewTitle: string
  inTrash: boolean
  sort: NoteSort
  selectedId: Id | null
  placement: NotesPlacement
  collapsed: boolean
  onToggle?: () => void
  onSort: (s: NoteSort) => void
  onSelect: (id: Id) => void
  onPlacement: (p: NotesPlacement) => void
}) {
  const other: NotesPlacement = placement === 'left' ? 'top' : 'left'
  return (
    <Section
      className={`notes notes-${placement}${inTrash ? ' trash' : ''}`}
      title={
        inTrash ? (
          <>Trash ({notes.length})</>
        ) : (
          <>
            Notes <span className="context">· {viewTitle} ({notes.length})</span>
          </>
        )
      }
      collapsed={collapsed}
      onToggle={onToggle}
      actions={
        <>
          <select value={sort} onChange={(e) => onSort(e.target.value as NoteSort)} title="Sort notes">
            <option value="updated">Last edited</option>
            <option value="created">Created</option>
            <option value="title">Title</option>
          </select>
          <button
            className="placement-toggle"
            title={other === 'top' ? 'Show notes above the editor' : 'Show notes in the left pane'}
            onClick={() => onPlacement(other)}
          >
            {other === 'top' ? '⬒' : '◧'}
          </button>
        </>
      }
    >
      <NoteList
        notes={notes}
        notebooks={notebooks}
        selectedId={selectedId}
        sort={sort}
        trashed={inTrash}
        emptyText={inTrash ? 'Trash is empty.' : 'No notes here yet.'}
        onSelect={onSelect}
      />
    </Section>
  )
}

/** The notes list above the editor, with a draggable divider; the list height is remembered per device. */
export function NotesAboveEditor({ notesSection, editor }: { notesSection: ReactNode; editor: ReactNode }) {
  const column = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState(() => Number(load(HEIGHT_KEY)) || DEFAULT_HEIGHT)
  // The live height, for saving on pointer-up (the handler's `height` can be a render behind the last move).
  const latest = useRef(height)
  latest.current = height
  const [dragging, setDragging] = useState(false)
  // Keep the editor usable when the window shrinks.
  const clamp = (h: number) => {
    const total = column.current?.clientHeight ?? Infinity
    return Math.round(Math.max(MIN_LIST, Math.min(h, total - MIN_EDITOR)))
  }
  useEffect(() => {
    const onResize = () => setHeight((h) => clamp(h))
    onResize()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  return (
    <div className={`right-column${dragging ? ' dragging' : ''}`} ref={column}>
      <div className="notes-strip" style={{ height }}>
        {notesSection}
      </div>
      <div
        className="splitter"
        role="separator"
        aria-orientation="horizontal"
        title="Drag to resize the notes list"
        onPointerDown={(e) => {
          e.preventDefault()
          e.currentTarget.setPointerCapture(e.pointerId)
          setDragging(true)
        }}
        onPointerMove={(e) => {
          if (!dragging || !column.current) return
          const h = clamp(e.clientY - column.current.getBoundingClientRect().top)
          latest.current = h
          setHeight(h)
        }}
        onPointerUp={() => {
          setDragging(false)
          save(HEIGHT_KEY, String(latest.current))
        }}
      />
      {editor}
    </div>
  )
}
