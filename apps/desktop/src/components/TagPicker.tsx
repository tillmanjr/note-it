import { useMemo, useRef, useState } from 'react'
import { tagPath, type Id, type NoteStore, type Tag } from '@tdjr/core'

interface Props {
  store: NoteStore
  tags: Tag[]
  value: Id[]
  disabled?: boolean
  /** `created` is true when new tags were created along the way. */
  onChange: (tagIds: Id[], created: boolean) => void
}

/** Most suggestions shown at once. */
const MAX_SUGGESTIONS = 12

/** Splits typed text into path levels. Leading "#" or "+" are prompts, not part of a name. */
function pathParts(path: string): string[] {
  return path
    .replace(/^[\s#+]+/, '')
    .split('/')
    .map((p) => p.trim())
    .filter(Boolean)
}

/** Finds the tag for a path like "projects/house", creating any missing levels. */
async function resolvePath(store: NoteStore, tags: Tag[], path: string): Promise<{ id: Id; created: boolean } | null> {
  const parts = pathParts(path)
  if (parts.length === 0) return null
  let parentId: Id | null = null
  let created = false
  const known = [...tags]
  for (const name of parts) {
    const existing = known.find(
      (t) => t.parentId === parentId && t.name.localeCompare(name, undefined, { sensitivity: 'base' }) === 0,
    )
    if (existing) {
      parentId = existing.id
    } else {
      const tag = await store.createTag(name, parentId)
      known.push(tag)
      parentId = tag.id
      created = true
    }
  }
  return parentId ? { id: parentId, created } : null
}

type Suggestion = { kind: 'tag'; id: Id; path: string; children: number } | { kind: 'create'; path: string }

export function TagPicker({ store, tags, value, disabled, onChange }: Props) {
  const [draft, setDraft] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null)

  const paths = useMemo(() => {
    const children = new Map<Id, number>()
    for (const t of tags) if (t.parentId) children.set(t.parentId, (children.get(t.parentId) ?? 0) + 1)
    return tags
      .map((t) => ({ id: t.id, path: tagPath(tags, t.id), children: children.get(t.id) ?? 0 }))
      .sort((a, b) => a.path.localeCompare(b.path))
  }, [tags])
  const pathOf = (id: Id) => paths.find((p) => p.id === id)?.path ?? '?'

  // Picking a suggestion adds that tag by id, so its displayed path never becomes part of a name.
  const suggestions = useMemo<Suggestion[]>(() => {
    const typed = pathParts(draft).join('/')
    const needle = typed.toLowerCase()
    // Exact path first, then paths or names that start with the text, then any other match.
    const rank = (path: string) => {
      const p = path.toLowerCase()
      if (p === needle) return 0
      if (p.startsWith(needle) || p.slice(p.lastIndexOf('/') + 1).startsWith(needle)) return 1
      return 2
    }
    const matches: Suggestion[] = paths
      .filter((p) => !value.includes(p.id) && p.path.toLowerCase().includes(needle))
      .sort((a, b) => rank(a.path) - rank(b.path))
      .slice(0, MAX_SUGGESTIONS)
      .map((p) => ({ kind: 'tag', ...p }))
    const exact = paths.some((p) => p.path.toLowerCase() === needle)
    return typed && !exact ? [...matches, { kind: 'create', path: typed }] : matches
  }, [draft, paths, value])

  const reset = () => {
    setDraft('')
    setActive(0)
  }

  const pick = async (s: Suggestion | undefined) => {
    if (!s) return
    reset()
    if (s.kind === 'tag') {
      onChange([...value, s.id], false)
      return
    }
    const resolved = await resolvePath(store, tags, s.path)
    if (resolved && !value.includes(resolved.id)) onChange([...value, resolved.id], resolved.created)
  }

  // Enter with nothing highlighted adds exactly what was typed (an existing path is reused).
  const addTyped = async () => {
    const resolved = await resolvePath(store, tags, draft)
    reset()
    if (resolved && !value.includes(resolved.id)) onChange([...value, resolved.id], resolved.created)
  }

  return (
    <div className="tag-picker">
      {value.map((id) => (
        <span key={id} className="tag-chip" title={pathOf(id)}>
          # {pathOf(id)}
          {!disabled && (
            <button title="Remove tag" onClick={() => onChange(value.filter((v) => v !== id), false)}>
              ×
            </button>
          )}
        </span>
      ))}
      {!disabled && (
        <div className="tag-combo">
          <input
            ref={input}
            value={draft}
            placeholder="Add tag (a/b for sub-tags)"
            role="combobox"
            aria-expanded={open && suggestions.length > 0}
            aria-autocomplete="list"
            onFocus={() => setOpen(true)}
            onBlur={() => setOpen(false)}
            onChange={(e) => {
              setDraft(e.target.value)
              setActive(0)
              setOpen(true)
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                setOpen(true)
                const step = e.key === 'ArrowDown' ? 1 : -1
                setActive((a) => Math.max(0, Math.min(suggestions.length - 1, a + step)))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                if (open && draft.trim() && suggestions[active]) void pick(suggestions[active])
                else void addTyped()
              } else if (e.key === 'Escape') {
                if (open) e.stopPropagation()
                setOpen(false)
              } else if (e.key === 'Backspace' && draft === '' && value.length > 0) {
                onChange(value.slice(0, -1), false)
              }
            }}
          />
          {open && suggestions.length > 0 && (
            <ul className="tag-suggestions" role="listbox">
              {suggestions.map((s, i) => (
                <li
                  key={s.kind === 'tag' ? s.id : 'create'}
                  role="option"
                  aria-selected={i === active}
                  className={`${i === active ? 'active' : ''} ${s.kind}`}
                  // mousedown, not click: the input's blur would close the list first.
                  onMouseDown={(e) => {
                    e.preventDefault()
                    void pick(s)
                  }}
                  onMouseEnter={() => setActive(i)}
                >
                  {s.kind === 'tag' ? (
                    <>
                      <span className="tag-suggestion-path">
                        {s.path.includes('/') && <span className="tag-suggestion-parent">{s.path.slice(0, s.path.lastIndexOf('/') + 1)}</span>}
                        {s.path.slice(s.path.lastIndexOf('/') + 1)}
                      </span>
                      {s.children > 0 && (
                        <span className="tag-suggestion-hint" title={`${s.children} sub-tag${s.children === 1 ? '' : 's'}`}>
                          ▸ {s.children}
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="tag-suggestion-path">
                      Create <b>{s.path}</b>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
