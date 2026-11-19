import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Id, NoteMeta, NoteSort, NoteStore, Notebook, Tag } from '@tdjr/core'
import { LeftPane, type View } from './LeftPane'
import { NoteEditor } from './NoteEditor'
import { SearchOverlay, type SearchScope } from './SearchOverlay'
import { ImportDialog } from './ImportDialog'
import { NotesAboveEditor, NotesSection, useNotesPlacement } from './NotesSection'
import { AddDeviceDialog, ConnectDialog, DevicesDialog } from './SyncDialogs'
import { useSync } from '../sync'

const LAST_NOTE_KEY = 'tdjr.lastNoteByView'

/** Views that remember their last opened note. Trash doesn't: nothing opens there by itself. */
function rememberKey(view: View): string | null {
  switch (view.kind) {
    case 'all':
      return 'all'
    case 'notebook':
    case 'tag':
      return `${view.kind}:${view.id}`
    case 'trash':
      return null
  }
}

function loadLastNotes(): Record<string, Id> {
  try {
    return JSON.parse(localStorage.getItem(LAST_NOTE_KEY) ?? '{}') as Record<string, Id>
  } catch {
    return {}
  }
}

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
  const sync = useSync(store)
  const [syncDialog, setSyncDialog] = useState<'connect' | 'add' | 'devices' | null>(null)

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
    return result
  }, [store, view, sort])

  useEffect(() => {
    void refreshOrganization()
  }, [refreshOrganization])

  // The last note opened in each notebook, tag and All notes; switching to one reopens it.
  const lastNotes = useRef<Record<string, Id>>(loadLastNotes())
  const notesRef = useRef(notes)
  notesRef.current = notes
  const viewRef = useRef(view)
  viewRef.current = view
  /** Bumped by every explicit open, so a slower automatic pick never overrides it. */
  const openSeq = useRef(0)
  const loadedView = useRef<string | null>(null)

  const showNote = useCallback(
    async (id: Id) => {
      const key = rememberKey(viewRef.current)
      if (key && notesRef.current.some((n) => n.id === id) && lastNotes.current[key] !== id) {
        lastNotes.current = { ...lastNotes.current, [key]: id }
        try {
          localStorage.setItem(LAST_NOTE_KEY, JSON.stringify(lastNotes.current))
        } catch {
          // Not remembered across restarts; still works for this session.
        }
      }
      setCurrent(await store.getNote(id))
    },
    [store],
  )

  useEffect(() => {
    const key = view.kind === 'notebook' || view.kind === 'tag' ? `${view.kind}:${view.id}` : view.kind
    const switched = loadedView.current !== key
    loadedView.current = key
    const seq = openSeq.current
    void refreshNotes().then((list) => {
      const remember = rememberKey(view)
      if (!switched || !remember || seq !== openSeq.current) return
      const last = lastNotes.current[remember]
      const pick = list.find((n) => n.id === last) ?? list[0]
      if (pick) void showNote(pick.id)
      else setCurrent(null)
    })
  }, [refreshNotes, view, showNote])

  // Changes from other devices: refresh the lists and the open note's details (its body updates itself).
  const currentId = useRef<Id | null>(null)
  currentId.current = current?.id ?? null
  useEffect(
    () =>
      store.onChange((e) => {
        if (e.type !== 'remote') return
        void refreshOrganization()
        void refreshNotes()
        const id = currentId.current
        if (!id) return
        if (e.purged.includes(id)) setCurrent(null)
        else if (e.metadata || e.bodies.has(id)) void store.getNote(id).then((n) => setCurrent((c) => (c?.id === id ? n : c)))
      }),
    [store, refreshOrganization, refreshNotes],
  )

  const openNote = useCallback(
    async (id: Id) => {
      openSeq.current++
      await showNote(id)
    },
    [showNote],
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
        sync={{
          status: sync.status,
          onConnect: () => setSyncDialog('connect'),
          onSyncNow: () => void sync.client?.syncNow(),
          onAddDevice: () => setSyncDialog('add'),
          onDevices: () => setSyncDialog('devices'),
        }}
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
      {syncDialog === 'connect' && <ConnectDialog onConnect={sync.connect} onClose={() => setSyncDialog(null)} />}
      {syncDialog === 'add' && sync.client && <AddDeviceDialog client={sync.client} onClose={() => setSyncDialog(null)} />}
      {syncDialog === 'devices' && sync.client && (
        <DevicesDialog client={sync.client} onDisconnectThis={sync.disconnect} onClose={() => setSyncDialog(null)} />
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
