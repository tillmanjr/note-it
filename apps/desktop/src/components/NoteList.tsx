import type { RefObject } from 'react'
import type { Id, NoteMeta, NoteSort, Notebook } from '@tdjr/core'

interface Props {
  searchRef: RefObject<HTMLInputElement | null>
  title: string
  notes: NoteMeta[]
  notebooks: Notebook[]
  selectedId: Id | null
  search: string
  sort: NoteSort
  canCreate: boolean
  onSearch: (s: string) => void
  onSort: (s: NoteSort) => void
  onSelect: (id: Id) => void
  onNew: () => void
}

export function formatWhen(ms: number): string {
  const d = new Date(ms)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  const sameYear = d.getFullYear() === now.getFullYear()
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) })
}

export function NoteList(p: Props) {
  const nbName = new Map(p.notebooks.map((n) => [n.id, n.name]))
  return (
    <section className="note-list">
      <header>
        <div className="title-row">
          <h2>{p.title}</h2>
          {p.canCreate && (
            <button className="primary" title="New note (Ctrl+N)" onClick={p.onNew}>
              ＋ New
            </button>
          )}
        </div>
        <input
          ref={p.searchRef}
          className="search"
          type="search"
          placeholder="Search (Ctrl+Shift+F)"
          value={p.search}
          onChange={(e) => p.onSearch(e.target.value)}
        />
        <div className="meta-row">
          <span>{p.notes.length} {p.notes.length === 1 ? 'note' : 'notes'}</span>
          <select value={p.sort} onChange={(e) => p.onSort(e.target.value as NoteSort)} title="Sort">
            <option value="updated">Last edited</option>
            <option value="created">Created</option>
            <option value="title">Title</option>
          </select>
        </div>
      </header>
      {p.notes.length === 0 && <div className="hint">{p.search ? 'No matches.' : 'No notes here yet.'}</div>}
      <ul>
        {p.notes.map((n) => (
          <li key={n.id} className={n.id === p.selectedId ? 'active' : ''} onClick={() => p.onSelect(n.id)}>
            <div className="note-title">{n.title || 'Untitled'}</div>
            <div className="note-snippet">{n.snippet || ' '}</div>
            <div className="note-meta">
              <span>{formatWhen(p.sort === 'created' ? n.createdAt : n.updatedAt)}</span>
              <span>{nbName.get(n.notebookId) ?? ''}</span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
