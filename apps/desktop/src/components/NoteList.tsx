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
  emptyText,
  onSelect,
}: {
  notes: NoteMeta[]
  notebooks: Notebook[]
  selectedId: Id | null
  sort: NoteSort
  emptyText: string
  onSelect: (id: Id) => void
}) {
  const nbName = new Map(notebooks.map((n) => [n.id, n.name]))
  if (notes.length === 0) return <div className="hint">{emptyText}</div>
  return (
    <ul className="note-list">
      {notes.map((n) => (
        <li key={n.id} className={n.id === selectedId ? 'active' : ''} onClick={() => onSelect(n.id)}>
          <div className="note-title">{n.title || 'Untitled'}</div>
          {n.snippet && <div className="note-snippet">{n.snippet}</div>}
          <div className="note-meta">
            <span>{formatWhen(sort === 'created' ? n.createdAt : n.updatedAt)}</span>
            <span>{nbName.get(n.notebookId) ?? ''}</span>
          </div>
        </li>
      ))}
    </ul>
  )
}
