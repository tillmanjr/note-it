import { useEffect, useMemo, useRef, useState } from 'react'
import { splitTagPath, tagPath, type Id, type NoteStore, type Tag } from '@tdjr/core'
import { Tooltip } from './Tooltip'

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

/**
 * A tag on the note, editable in place: clicking it turns it into a text box with its path, and the edited path
 * replaces it on this note only (the tag itself isn't renamed; that's done in the tag list).
 */
function TagChip({ path, disabled, onEdit, onRemove }: {
  path: string
  disabled?: boolean
  onEdit: (path: string) => void
  onRemove: () => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const box = useRef<HTMLInputElement>(null)
  useEffect(() => {
    // Caret at the end, ready to type "/sub-tag".
    if (draft !== null) box.current?.setSelectionRange(draft.length, draft.length)
  }, [draft === null])
  const commit = () => {
    if (draft === null) return
    setDraft(null)
    if (splitTagPath(draft).join('/') !== splitTagPath(path).join('/')) onEdit(draft)
  }

  if (draft !== null) {
    return (
      <span className="tag-chip editing">
        #{' '}
        <input
          ref={box}
          autoFocus
          value={draft}
          aria-label="Tag path"
          style={{ width: `${Math.max(draft.length, 4) + 1}ch` }}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commit()
            } else if (e.key === 'Escape') {
              e.stopPropagation()
              setDraft(null)
            }
          }}
        />
      </span>
    )
  }
  return (
    <span className="tag-chip">
      {disabled ? (
        <span># {path}</span>
      ) : (
        <Tooltip tip="Edit this note's tag">
          <button className="tag-chip-label" onClick={() => setDraft(path)}>
            # {path}
          </button>
        </Tooltip>
      )}
      {!disabled && (
        <Tooltip tip="Remove tag">
          <button aria-label="Remove tag" onClick={onRemove}>
            ×
          </button>
        </Tooltip>
      )}
    </span>
  )
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
    const typed = splitTagPath(draft).join('/')
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
    const resolved = await store.findOrCreateTagPath(s.path)
    if (resolved && !value.includes(resolved.id)) onChange([...value, resolved.id], resolved.created)
  }

  // Enter with nothing highlighted adds exactly what was typed (an existing path is reused).
  const addTyped = async () => {
    const resolved = await store.findOrCreateTagPath(draft)
    reset()
    if (resolved && !value.includes(resolved.id)) onChange([...value, resolved.id], resolved.created)
  }

  // An edited chip: the new path takes the old tag's place on this note.
  const replace = async (id: Id, path: string) => {
    const resolved = await store.findOrCreateTagPath(path)
    if (!resolved) return
    const next = value.flatMap((v) => (v === id ? [resolved.id] : v === resolved.id ? [] : [v]))
    onChange(next, resolved.created)
  }

  return (
    <div className="tag-picker">
      {value.map((id) => (
        <TagChip
          key={id}
          path={pathOf(id)}
          disabled={disabled}
          onEdit={(path) => void replace(id, path)}
          onRemove={() => onChange(value.filter((v) => v !== id), false)}
        />
      ))}
      {!disabled && (
        <Tooltip
          className="tag-combo"
          disabled={open && suggestions.length > 0}
          tip={
            <>
              Type <b>a/b</b> to add sub-tag <b>b</b> under <b>a</b>. <b>Tab</b> completes a suggestion.
            </>
          }
        >
          <input
            ref={input}
            value={draft}
            placeholder="Add Tag"
            aria-description="Type a/b to add a sub-tag b under a. Tab completes a suggestion."
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
              } else if (e.key === 'Tab' && open && draft.trim() && suggestions[active]?.kind === 'tag') {
                // Tab completes the highlighted tag's path, ready for "/sub-tag": "Ingr" → "Ingredients/".
                e.preventDefault()
                setDraft(`${suggestions[active].path}/`)
                setActive(0)
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
        </Tooltip>
      )}
    </div>
  )
}
