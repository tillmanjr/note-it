import { useMemo, useState } from 'react'
import { buildTagTree, type Id, type NoteStore, type Notebook, type Tag, type TagNode } from '@tdjr/core'
import { ConfirmButton, InlineEdit } from './controls'

export type View = { kind: 'all' } | { kind: 'trash' } | { kind: 'notebook'; id: Id } | { kind: 'tag'; id: Id }

interface Props {
  store: NoteStore
  notebooks: Notebook[]
  tags: Tag[]
  view: View
  onView: (v: View) => void
  onChanged: () => Promise<void>
}

export function Sidebar({ store, notebooks, tags, view, onView, onChanged }: Props) {
  const [editing, setEditing] = useState<Id | null>(null)
  const [collapsed, setCollapsed] = useState<Set<Id>>(new Set())
  const tree = useMemo(() => buildTagTree(tags), [tags])

  const isActive = (v: View) =>
    v.kind === view.kind && (!('id' in v) || ('id' in view && view.id === v.id))

  const run = async (action: () => Promise<unknown>) => {
    await action()
    await onChanged()
  }

  const addNotebook = () =>
    run(async () => {
      const nb = await store.createNotebook('New notebook')
      setEditing(nb.id)
    })

  const addTag = (parentId: Id | null) =>
    run(async () => {
      const tag = await store.createTag('new tag', parentId)
      if (parentId) setCollapsed((s) => new Set([...s].filter((id) => id !== parentId)))
      setEditing(tag.id)
    })

  const toggle = (id: Id) =>
    setCollapsed((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const renderTag = (node: TagNode, depth: number) => {
    const { tag } = node
    const v: View = { kind: 'tag', id: tag.id }
    const open = !collapsed.has(tag.id)
    return (
      <li key={tag.id}>
        <div
          className={`row ${isActive(v) ? 'active' : ''}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => onView(v)}
          onDoubleClick={() => setEditing(tag.id)}
        >
          <button
            className={`twisty ${node.children.length ? '' : 'leaf'}`}
            onClick={(e) => {
              e.stopPropagation()
              toggle(tag.id)
            }}
          >
            {node.children.length ? (open ? '▾' : '▸') : '•'}
          </button>
          <InlineEdit
            value={tag.name}
            editing={editing === tag.id}
            onCommit={(name) => {
              setEditing(null)
              if (name.trim() && name !== tag.name) void run(() => store.renameTag(tag.id, name))
            }}
            onCancel={() => setEditing(null)}
          />
          <span className="row-actions">
            <button title="New sub-tag" onClick={(e) => (e.stopPropagation(), void addTag(tag.id))}>＋</button>
            <button title="Rename" onClick={(e) => (e.stopPropagation(), setEditing(tag.id))}>✎</button>
            <ConfirmButton
              label="🗑"
              confirmLabel="Delete?"
              title="Delete tag and its sub-tags (notes are kept)"
              onConfirm={() => {
                if (isActive(v)) onView({ kind: 'all' })
                void run(() => store.deleteTag(tag.id))
              }}
            />
          </span>
        </div>
        {open && node.children.length > 0 && <ul>{node.children.map((c) => renderTag(c, depth + 1))}</ul>}
      </li>
    )
  }

  return (
    <nav className="sidebar">
      <div className={`row top ${isActive({ kind: 'all' }) ? 'active' : ''}`} onClick={() => onView({ kind: 'all' })}>
        <span className="label">All notes</span>
      </div>

      <div className="section">
        <span>Notebooks</span>
        <button title="New notebook" onClick={() => void addNotebook()}>＋</button>
      </div>
      <ul>
        {notebooks.map((nb) => {
          const v: View = { kind: 'notebook', id: nb.id }
          return (
            <li key={nb.id}>
              <div className={`row ${isActive(v) ? 'active' : ''}`} onClick={() => onView(v)} onDoubleClick={() => setEditing(nb.id)}>
                <InlineEdit
                  value={nb.name}
                  editing={editing === nb.id}
                  onCommit={(name) => {
                    setEditing(null)
                    if (name.trim() && name !== nb.name) void run(() => store.renameNotebook(nb.id, name))
                  }}
                  onCancel={() => setEditing(null)}
                />
                <span className="row-actions">
                  <button title="Rename" onClick={(e) => (e.stopPropagation(), setEditing(nb.id))}>✎</button>
                  {notebooks.length > 1 && (
                    <ConfirmButton
                      label="🗑"
                      confirmLabel="Delete?"
                      title="Delete notebook (its notes move to Trash)"
                      onConfirm={() => {
                        if (isActive(v)) onView({ kind: 'all' })
                        void run(() => store.deleteNotebook(nb.id))
                      }}
                    />
                  )}
                </span>
              </div>
            </li>
          )
        })}
      </ul>

      <div className="section">
        <span>Tags</span>
        <button title="New tag" onClick={() => void addTag(null)}>＋</button>
      </div>
      <ul className="tags">{tree.map((n) => renderTag(n, 0))}</ul>
      {tree.length === 0 && <div className="hint">No tags yet. Add one here or type a path like projects/house on a note.</div>}

      <div className={`row top trash ${isActive({ kind: 'trash' }) ? 'active' : ''}`} onClick={() => onView({ kind: 'trash' })}>
        <span className="label">🗑 Trash</span>
      </div>
    </nav>
  )
}
