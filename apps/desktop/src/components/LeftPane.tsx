import { useMemo, useState } from 'react'
import { buildTagTree, tagPath, type Id, type NoteMeta, type NoteSort, type NoteStore, type Notebook, type Tag, type TagNode } from '@tdjr/core'
import { ConfirmButton, ConfirmDialog, InlineEdit } from './controls'
import { SettingsMenu, type SyncMenu } from './SettingsMenu'
import { useTheme } from '../theme'
import { Logo } from './Logo'
import { NotesSection, type NotesPlacement } from './NotesSection'
import { Section, useCollapsedSections } from './Section'

export type View = { kind: 'all' } | { kind: 'trash' } | { kind: 'notebook'; id: Id } | { kind: 'tag'; id: Id }

interface Props {
  store: NoteStore
  notebooks: Notebook[]
  tags: Tag[]
  view: View
  viewTitle: string
  notes: NoteMeta[]
  sort: NoteSort
  selectedId: Id | null
  notesPlacement: NotesPlacement
  onNotesPlacement: (p: NotesPlacement) => void
  onView: (v: View) => void
  onSort: (s: NoteSort) => void
  onSelect: (id: Id) => void
  onNew: () => void
  onSearch: () => void
  onImport: () => void
  sync: SyncMenu
  onChanged: () => Promise<void>
}

// Single left pane: app bar (⚙ menu), actions, then collapsible Notebooks / Tags / Notes sections, Trash pinned at the bottom.
// Notes can instead sit above the editor (see NotesAboveEditor); then Notebooks and Tags share the pane.
export function LeftPane({
  store, notebooks, tags, view, viewTitle, notes, sort, selectedId, notesPlacement, onNotesPlacement,
  onView, onSort, onSelect, onNew, onSearch, onImport, sync, onChanged,
}: Props) {
  const [editing, setEditing] = useState<Id | null>(null)
  const [collapsed, setCollapsed] = useState<Set<Id>>(new Set())
  const sections = useCollapsedSections()
  // Owned here (always mounted) so System mode keeps following the OS while the menu is closed.
  const [theme, setTheme] = useTheme()
  // Trashed-note count while the Empty Trash confirmation is open.
  const [emptying, setEmptying] = useState<number | null>(null)
  const inTrash = view.kind === 'trash'
  // The current notebook / tag, echoed in its section header so it stays visible when collapsed.
  const selectedNotebook = view.kind === 'notebook' ? notebooks.find((n) => n.id === view.id)?.name : undefined
  const selectedTag = view.kind === 'tag' ? tagPath(tags, view.id) : undefined
  const clearSelection = () => onView({ kind: 'all' })
  // Opening a view is almost always to see its notes, so it expands the Notes section.
  const open = (v: View) => {
    sections.expand('notes')
    onView(v)
  }
  // Clicking the selected notebook/tag again unselects it.
  const select = (v: View) => (isActive(v) ? clearSelection() : open(v))
  const withSelection = (label: string, selection?: string) => (
    <>
      {label}
      {selection && (
        <span className="selection">
          {' '}({selection}
          <button
            className="clear-selection"
            title="Clear selection"
            onClick={(e) => {
              e.stopPropagation()
              clearSelection()
            }}
          >
            ×
          </button>
          )
        </span>
      )}
    </>
  )
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
          // Names align with notebook rows; each level indents one step. The fold toggle hangs in the margin.
          style={{ paddingLeft: 12 + depth * 14 }}
          onClick={() => select(v)}
          onDoubleClick={() => setEditing(tag.id)}
        >
          {node.children.length ? (
            <button
              className="twisty"
              style={{ left: 1 + depth * 14 }}
              title={open ? 'Collapse' : 'Expand'}
              onClick={(e) => {
                e.stopPropagation()
                toggle(tag.id)
              }}
            >
              {open ? '▾' : '▸'}
            </button>
          ) : null}
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
    <nav className="left-pane">
      <header className="app-bar">
        <Logo />
        <SettingsMenu theme={theme} onTheme={setTheme} onImport={onImport} sync={sync} />
      </header>
      <div className="pane-top">
        <button className="primary" title="New note (Ctrl+N)" onClick={onNew} disabled={view.kind === 'trash'}>
          ＋ New note
        </button>
        <button className="search-button" title="Search (Ctrl+Shift+F)" onClick={onSearch}>
          🔍 Search
        </button>
      </div>

      <div className="pane-sections">
        <Section
          className="notebooks"
          title={withSelection('Notebooks', selectedNotebook)}
          collapsed={sections.isCollapsed('notebooks')}
          onToggle={() => sections.toggle('notebooks')}
          actions={<button title="New notebook" onClick={() => void addNotebook()}>＋</button>}
        >
          <ul>
            <li>
              <div className={`row ${isActive({ kind: 'all' }) ? 'active' : ''}`} onClick={() => open({ kind: 'all' })}>
                <span className="label">All notes</span>
              </div>
            </li>
            {notebooks.map((nb) => {
              const v: View = { kind: 'notebook', id: nb.id }
              return (
                <li key={nb.id}>
                  <div className={`row ${isActive(v) ? 'active' : ''}`} onClick={() => select(v)} onDoubleClick={() => setEditing(nb.id)}>
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
        </Section>

        <Section
          className="tags"
          title={withSelection('Tags', selectedTag)}
          collapsed={sections.isCollapsed('tags')}
          onToggle={() => sections.toggle('tags')}
          actions={<button title="New tag" onClick={() => void addTag(null)}>＋</button>}
        >
          <ul>{tree.map((n) => renderTag(n, 0))}</ul>
          {tree.length === 0 && <div className="hint">No tags yet. Add one here or type a path like projects/house on a note.</div>}
        </Section>

        {notesPlacement === 'left' && (
          <NotesSection
            notes={notes}
            notebooks={notebooks}
            viewTitle={viewTitle}
            inTrash={inTrash}
            sort={sort}
            selectedId={selectedId}
            placement="left"
            collapsed={sections.isCollapsed('notes')}
            onToggle={() => sections.toggle('notes')}
            onSort={onSort}
            onSelect={onSelect}
            onPlacement={onNotesPlacement}
          />
        )}
      </div>

      <div className={`row pane-bottom ${isActive({ kind: 'trash' }) ? 'active' : ''}`} onClick={() => open({ kind: 'trash' })}>
        <span className="label">🗑 Trash</span>
        <span className="row-actions">
          <button
            title="Permanently delete every note in the Trash"
            onClick={async (e) => {
              e.stopPropagation()
              setEmptying((await store.queryNotes({ trash: true })).length)
            }}
          >
            Empty
          </button>
        </span>
      </div>
      {emptying !== null && (
        <ConfirmDialog
          title="Empty Trash"
          message={
            emptying === 0
              ? 'The Trash is already empty.'
              : `Permanently delete ${emptying} ${emptying === 1 ? 'note' : 'notes'}? This can't be undone.`
          }
          confirmLabel={emptying === 0 ? 'OK' : 'Delete forever'}
          onCancel={() => setEmptying(null)}
          onConfirm={() => {
            setEmptying(null)
            void run(() => store.emptyTrash())
          }}
        />
      )}
    </nav>
  )
}
