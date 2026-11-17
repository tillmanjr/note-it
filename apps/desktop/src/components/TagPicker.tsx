import { useMemo, useState } from 'react'
import { tagPath, type Id, type NoteStore, type Tag } from '@tdjr/core'

interface Props {
  store: NoteStore
  tags: Tag[]
  value: Id[]
  disabled?: boolean
  /** `created` is true when new tags were created along the way. */
  onChange: (tagIds: Id[], created: boolean) => void
}

/** Finds the tag for a path like "projects/house", creating any missing levels. */
async function resolvePath(store: NoteStore, tags: Tag[], path: string): Promise<{ id: Id; created: boolean } | null> {
  const parts = path.split('/').map((p) => p.trim()).filter(Boolean)
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

export function TagPicker({ store, tags, value, disabled, onChange }: Props) {
  const [draft, setDraft] = useState('')
  const paths = useMemo(
    () => tags.map((t) => ({ id: t.id, path: tagPath(tags, t.id) })).sort((a, b) => a.path.localeCompare(b.path)),
    [tags],
  )
  const pathOf = (id: Id) => paths.find((p) => p.id === id)?.path ?? '?'

  const add = async () => {
    const resolved = await resolvePath(store, tags, draft)
    setDraft('')
    if (!resolved || value.includes(resolved.id)) return
    onChange([...value, resolved.id], resolved.created)
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
        <>
          <input
            list="tag-paths"
            value={draft}
            placeholder="+ tag (a/b for sub-tags)"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void add()
              } else if (e.key === 'Backspace' && draft === '' && value.length > 0) {
                onChange(value.slice(0, -1), false)
              }
            }}
          />
          <datalist id="tag-paths">
            {paths
              .filter((p) => !value.includes(p.id))
              .map((p) => (
                <option key={p.id} value={p.path} />
              ))}
          </datalist>
        </>
      )}
    </div>
  )
}
