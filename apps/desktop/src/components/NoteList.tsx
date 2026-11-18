import type { Id, NoteMeta, NoteSort, Notebook } from '@tdjr/core'

export function formatWhen(ms: number): string {
  const d = new Date(ms)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  const sameYear = d.getFullYear() === now.getFullYear()
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) })
}

export function NoteList({
  notes,
  notebooks,
  selectedId,
  sort,
  trashed = false,
  emptyText,
  onSelect,
}: {
  notes: NoteMeta[]
  notebooks: Notebook[]
  selectedId: Id | null
  sort: NoteSort
  /** The notes are in the Trash: styled so they can't be mistaken for live notes. */
  trashed?: boolean
  emptyText: string
  onSelect: (id: Id) => void
}) {
  const nbName = new Map(notebooks.map((n) => [n.id, n.name]))
  if (notes.length === 0) return <div className="hint">{emptyText}</div>
  return (
    <ul className={trashed ? 'note-list trashed' : 'note-list'}>
      {notes.map((n) => {
        // One line per note keeps long lists scannable; the snippet and notebook are in the tooltip.
        const tip = [nbName.get(n.notebookId), n.snippet].filter(Boolean).join(' — ')
        return (
          <li key={n.id} className={n.id === selectedId ? 'active' : ''} title={tip} onClick={() => onSelect(n.id)}>
            <span className="note-title">{n.title || 'Untitled'}</span>
            <span className="note-when">{formatWhen(sort === 'created' ? n.createdAt : n.updatedAt)}</span>
          </li>
        )
      })}
    </ul>
  )
}
