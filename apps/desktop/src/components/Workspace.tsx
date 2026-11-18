import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Id, NoteMeta, NoteSort, NoteStore, Notebook, Tag } from '@tdjr/core'
import { LeftPane, type View } from './LeftPane'
import { NoteEditor } from './NoteEditor'
import { SearchOverlay, type SearchScope } from './SearchOverlay'
import { ImportDialog } from './ImportDialog'
import { NotesAboveEditor, NotesSection, useNotesPlacement } from './NotesSection'

// Two panes: left (notebooks, tags, notes, trash) and the editor. The notes list can instead sit above the
// editor. Search is an overlay.
export function Workspace({ store }: { store: NoteStore }) {
  const [notebooks, setNotebooks] = useState<Notebook[]>([])
  const [tags, setTags] = useState<Tag[]>([])
  const [view, setView] = useState<View>({ kind: 'all' })
  const [sort, setSort] = useState<NoteSort>('updated')
  const [notes, setNotes] = useState<NoteMeta[]>([])
  // The open note is tracked separately from the list: a search result may be outside the current view.
  const [current, setCurrent] = useState<NoteMeta | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [notesPlacement, setNotesPlacement] = useNotesPlacement()

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
      sort,
    })
    setNotes(result)
  }, [store, view, sort])

  useEffect(() => {
    void refreshOrganization()
  }, [refreshOrganization])

  useEffect(() => {
    void refreshNotes()
  }, [refreshNotes])

  const openNote = useCallback(
    async (id: Id) => {
      setCurrent(await store.getNote(id))
    },
    [store],
  )

  const newNote = useCallback(async () => {
    const notebookId = view.kind === 'notebook' ? view.id : notebooks[0]?.id
    if (!notebookId) return
    const note = await store.createNote(notebookId)
    if (view.kind === 'tag') await store.setNoteTags(note.id, [view.id])
    if (view.kind === 'trash') setView({ kind: 'all' })
    await refreshNotes()
    await openNote(note.id)
  }, [store, view, notebooks, refreshNotes, openNote])

  // Keep the list and the open note in step with edits without re-querying on every keystroke.
  const patchNote = useCallback(
    (id: Id, patch: Partial<NoteMeta>) => {
      setNotes((prev) => {
        const next = prev.map((n) => (n.id === id ? { ...n, ...patch } : n))
        if (sort === 'updated' && patch.updatedAt) next.sort((a, b) => b.updatedAt - a.updatedAt)
        return next
      })
      setCurrent((cur) => (cur && cur.id === id ? { ...cur, ...patch } : cur))
    },
    [sort],
  )

  const closeRemoved = useCallback(
    (id: Id) => {
      setNotes((prev) => prev.filter((n) => n.id !== id))
      setCurrent((cur) => (cur?.id === id ? null : cur))
      void refreshNotes()
    },
    [refreshNotes],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        void newNote()
      } else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setSearchOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [newNote])

  const title = viewTitle(view, notebooks, tags)
  const searchScope = useMemo<SearchScope | null>(() => {
    if (view.kind === 'notebook') return { label: title, notebookId: view.id }
    if (view.kind === 'tag') return { label: title, tagId: view.id }
    return null
  }, [view, title])

  const editor = current ? (
    <NoteEditor
      key={current.id}
      store={store}
      note={current}
      notebooks={notebooks}
      tags={tags}
      onPatch={(patch) => patchNote(current.id, patch)}
      onTagsCreated={refreshOrganization}
      onRemoved={() => closeRemoved(current.id)}
    />
  ) : (
    <div className="editor-pane empty">
      {view.kind === 'trash' ? 'Select a note to restore or delete it.' : 'Select a note, or press Ctrl+N for a new one.'}
    </div>
  )

  return (
    <div className="workspace">
      <LeftPane
        store={store}
        notebooks={notebooks}
        tags={tags}
        view={view}
        viewTitle={title}
        notes={notes}
        sort={sort}
        selectedId={current?.id ?? null}
        notesPlacement={notesPlacement}
        onNotesPlacement={setNotesPlacement}
        onView={setView}
        onSort={setSort}
        onSelect={(id) => void openNote(id)}
        onNew={() => void newNote()}
        onSearch={() => setSearchOpen(true)}
        onImport={() => setImportOpen(true)}
        onChanged={async () => {
          await refreshOrganization()
          await refreshNotes()
          if (current) await openNote(current.id)
        }}
      />
      {notesPlacement === 'top' ? (
        <NotesAboveEditor
          notesSection={
            <NotesSection
              notes={notes}
              notebooks={notebooks}
              viewTitle={title}
              inTrash={view.kind === 'trash'}
              sort={sort}
              selectedId={current?.id ?? null}
              placement="top"
              collapsed={false}
              onSort={setSort}
              onSelect={(id) => void openNote(id)}
              onPlacement={setNotesPlacement}
            />
          }
          editor={editor}
        />
      ) : (
        editor
      )}
      {importOpen && (
        <ImportDialog
          store={store}
          notebooks={notebooks}
          onClose={async (notebookId) => {
            setImportOpen(false)
            await refreshOrganization()
            if (notebookId) setView({ kind: 'notebook', id: notebookId })
            else await refreshNotes()
          }}
        />
      )}
      {searchOpen && (
        <SearchOverlay
          store={store}
          notebooks={notebooks}
          scope={searchScope}
          onOpen={(id) => {
            setSearchOpen(false)
            void openNote(id)
          }}
          onClose={() => setSearchOpen(false)}
        />
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
      return `#${tags.find((t) => t.id === view.id)?.name ?? 'tag'}`
  }
}
