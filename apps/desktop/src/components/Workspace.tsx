import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Id, NoteMeta, NoteSort, NoteStore, Notebook, Tag } from '@tdjr/core'
import { Sidebar, type View } from './Sidebar'
import { NoteList } from './NoteList'
import { NoteEditor } from './NoteEditor'

// Three-pane layout: sidebar (notebooks, tags, trash) → note list → editor.
export function Workspace({ store }: { store: NoteStore }) {
  const [notebooks, setNotebooks] = useState<Notebook[]>([])
  const [tags, setTags] = useState<Tag[]>([])
  const [view, setView] = useState<View>({ kind: 'all' })
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<NoteSort>('updated')
  const [notes, setNotes] = useState<NoteMeta[]>([])
  const [selectedId, setSelectedId] = useState<Id | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const refreshOrganization = useCallback(async () => {
    const [nbs, ts] = await Promise.all([store.listNotebooks(), store.listTags()])
    setNotebooks(nbs)
    setTags(ts)
  }, [store])

  const refreshNotes = useCallback(async () => {
    const result = await store.queryNotes({
      notebookId: view.kind === 'notebook' ? view.id : undefined,
      tagId: view.kind === 'tag' ? view.id : undefined,
      trash: view.kind === 'trash',
      text: search,
      sort,
    })
    setNotes(result)
  }, [store, view, search, sort])

  useEffect(() => {
    void refreshOrganization()
  }, [refreshOrganization])

  useEffect(() => {
    void refreshNotes()
  }, [refreshNotes])

  const selected = useMemo(() => notes.find((n) => n.id === selectedId) ?? null, [notes, selectedId])

  const newNote = useCallback(async () => {
    const notebookId = view.kind === 'notebook' ? view.id : notebooks[0]?.id
    if (!notebookId) return
    const note = await store.createNote(notebookId)
    if (view.kind === 'tag') await store.setNoteTags(note.id, [view.id])
    if (view.kind === 'trash') setView({ kind: 'all' })
    setSearch('')
    await refreshNotes()
    setNotes((prev) => (prev.some((n) => n.id === note.id) ? prev : [note, ...prev]))
    setSelectedId(note.id)
  }, [store, view, notebooks, refreshNotes])

  // Keep the list in step with edits without re-querying on every keystroke.
  const patchNote = useCallback(
    (id: Id, patch: Partial<NoteMeta>) => {
      setNotes((prev) => {
        const next = prev.map((n) => (n.id === id ? { ...n, ...patch } : n))
        if (sort === 'updated' && patch.updatedAt) next.sort((a, b) => b.updatedAt - a.updatedAt)
        return next
      })
    },
    [sort],
  )

  const removeFromList = useCallback((id: Id) => {
    setNotes((prev) => prev.filter((n) => n.id !== id))
    setSelectedId((cur) => (cur === id ? null : cur))
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        void newNote()
      } else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [newNote])

  return (
    <div className="workspace">
      <Sidebar
        store={store}
        notebooks={notebooks}
        tags={tags}
        view={view}
        onView={(v) => {
          setView(v)
          setSelectedId(null)
        }}
        onChanged={async () => {
          await refreshOrganization()
          await refreshNotes()
        }}
      />
      <NoteList
        searchRef={searchRef}
        title={viewTitle(view, notebooks, tags)}
        notes={notes}
        notebooks={notebooks}
        selectedId={selectedId}
        search={search}
        sort={sort}
        canCreate={view.kind !== 'trash'}
        onSearch={setSearch}
        onSort={setSort}
        onSelect={setSelectedId}
        onNew={() => void newNote()}
      />
      {selected ? (
        <NoteEditor
          key={selected.id}
          store={store}
          note={selected}
          notebooks={notebooks}
          tags={tags}
          onPatch={(patch) => patchNote(selected.id, patch)}
          onTagsCreated={refreshOrganization}
          onRemoved={() => removeFromList(selected.id)}
        />
      ) : (
        <div className="editor-pane empty">
          {view.kind === 'trash' ? 'Select a note to restore or delete it.' : 'Select a note, or press Ctrl+N for a new one.'}
        </div>
      )}
    </div>
  )
}

function viewTitle(view: View, notebooks: Notebook[], tags: Tag[]): string {
  switch (view.kind) {
    case 'all':
      return 'All notes'
    case 'trash':
      return 'Trash'
    case 'notebook':
      return notebooks.find((n) => n.id === view.id)?.name ?? 'Notebook'
    case 'tag':
      return `# ${tags.find((t) => t.id === view.id)?.name ?? 'Tag'}`
  }
}
