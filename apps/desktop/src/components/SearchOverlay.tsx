import { useEffect, useRef, useState, type ReactNode } from 'react'
import { HIT_END, HIT_START, type Id, type NoteStore, type Notebook, type SearchHit } from '@tdjr/core'
import { formatWhen } from './NoteList'

const SEARCH_DELAY_MS = 120

export interface SearchScope {
  label: string
  notebookId?: Id
  tagId?: Id
}

interface Props {
  store: NoteStore
  notebooks: Notebook[]
  /** The current notebook/tag, offered as a narrower scope. Null when browsing all notes or Trash. */
  scope: SearchScope | null
  onOpen: (id: Id) => void
  onClose: () => void
}

/** Renders an excerpt with the store's hit markers as <mark>. */
function Excerpt({ text }: { text: string }) {
  const parts: ReactNode[] = []
  let rest = text
  let key = 0
  while (rest) {
    const start = rest.indexOf(HIT_START)
    if (start < 0) {
      parts.push(rest)
      break
    }
    const end = rest.indexOf(HIT_END, start)
    parts.push(rest.slice(0, start))
    parts.push(<mark key={key++}>{rest.slice(start + 1, end < 0 ? undefined : end)}</mark>)
    rest = end < 0 ? '' : rest.slice(end + 1)
  }
  return <>{parts}</>
}

// Overlay search: type to search, arrows to move, Enter to open, Esc to close.
export function SearchOverlay({ store, notebooks, scope, onOpen, onClose }: Props) {
  const [text, setText] = useState('')
  const [scoped, setScoped] = useState(false)
  const [hits, setHits] = useState<SearchHit[]>([])
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLUListElement>(null)
  const nbName = new Map(notebooks.map((n) => [n.id, n.name]))

  useEffect(() => {
    let cancelled = false
    const t = setTimeout(() => {
      const where = scoped && scope ? { notebookId: scope.notebookId, tagId: scope.tagId } : {}
      void store.searchNotes(text, where).then((r) => {
        if (cancelled) return
        setHits(r)
        setActive(0)
      })
    }, SEARCH_DELAY_MS)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [store, text, scoped, scope])

  useEffect(() => {
    listRef.current?.querySelector('li.active')?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const open = (i: number) => {
    const hit = hits[i]
    if (hit) onOpen(hit.note.id)
  }

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="search-panel" role="dialog" aria-label="Search notes" onMouseDown={(e) => e.stopPropagation()}>
        <div className="search-input-row">
          <span className="icon">🔍</span>
          <input
            autoFocus
            value={text}
            placeholder="Search notes…"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose()
              else if (e.key === 'ArrowDown') {
                e.preventDefault()
                setActive((a) => Math.min(a + 1, hits.length - 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setActive((a) => Math.max(a - 1, 0))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                open(active)
              }
            }}
          />
        </div>
        {scope && (
          <div className="search-scope">
            <button className={scoped ? '' : 'active'} onClick={() => setScoped(false)}>
              All notes
            </button>
            <button className={scoped ? 'active' : ''} onClick={() => setScoped(true)}>
              In {scope.label}
            </button>
          </div>
        )}
        <ul ref={listRef} className="search-results">
          {hits.map((h, i) => (
            <li key={h.note.id} className={i === active ? 'active' : ''} onMouseEnter={() => setActive(i)} onClick={() => open(i)}>
              <div className="note-title">{h.note.title || 'Untitled'}</div>
              {h.excerpt && (
                <div className="excerpt">
                  <Excerpt text={h.excerpt} />
                </div>
              )}
              <div className="note-meta">
                <span>{nbName.get(h.note.notebookId) ?? ''}</span>
                <span>{formatWhen(h.note.updatedAt)}</span>
              </div>
            </li>
          ))}
        </ul>
        {text.trim() && hits.length === 0 && <div className="hint">No matches.</div>}
        {!text.trim() && <div className="hint">Matches words by prefix: “kit ren” finds “kitchen renovation”.</div>}
      </div>
    </div>
  )
}
