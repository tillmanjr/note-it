import { useEffect, useMemo, useRef, useState } from 'react'
import * as Y from 'yjs'
import { EditorContent, useEditor } from '@tiptap/react'
import { attachmentRef, parseAttachmentRef, type Id, type NoteMeta, type NoteStore, type Notebook, type Tag } from '@tdjr/core'
import { isChangeOrigin, noteExtensions, SelectionFormatBar, Toolbar } from '@tdjr/editor'
import { TagPicker } from './TagPicker'
import { ConfirmButton } from './controls'
import { formatWhen } from './NoteList'

const LOAD_ORIGIN = 'load'
const SAVE_DELAY_MS = 300
const INDEX_DELAY_MS = 800
const TITLE_DELAY_MS = 400

interface Props {
  store: NoteStore
  note: NoteMeta
  notebooks: Notebook[]
  tags: Tag[]
  onPatch: (patch: Partial<NoteMeta>) => void
  onTagsCreated: () => Promise<void>
  onRemoved: () => void
}

// One instance per open note (keyed by id in the parent).
export function NoteEditor({ store, note, notebooks, tags, onPatch, onTagsCreated, onRemoved }: Props) {
  const [doc, setDoc] = useState<Y.Doc | null>(null)
  const [title, setTitle] = useState(note.title)
  const trashed = note.deletedAt !== null
  const bodyFocus = useRef<() => void>(() => {})

  useEffect(() => {
    let cancelled = false
    const d = new Y.Doc()
    void store.loadNoteBody(note.id).then((body) => {
      if (body) Y.applyUpdate(d, body, LOAD_ORIGIN)
      if (!cancelled) setDoc(d)
    })
    return () => {
      cancelled = true
    }
  }, [store, note.id])

  // Debounced title save.
  const titleTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const saveTitle = (value: string, delay = TITLE_DELAY_MS) => {
    clearTimeout(titleTimer.current)
    titleTimer.current = setTimeout(() => {
      void store.setNoteTitle(note.id, value)
      onPatch({ title: value, updatedAt: Date.now() })
    }, delay)
  }
  useEffect(() => () => clearTimeout(titleTimer.current), [])

  return (
    <div className="editor-pane">
      <div className="note-header">
        {trashed && (
          <div className="trash-bar">
            <span>This note is in the Trash.</span>
            <button
              onClick={async () => {
                await store.restoreNote(note.id, notebooks[0].id)
                onRemoved()
              }}
            >
              Restore
            </button>
            <ConfirmButton
              label="Delete forever"
              confirmLabel="Really delete?"
              title="Permanently delete this note"
              onConfirm={async () => {
                await store.purgeNote(note.id)
                onRemoved()
              }}
            />
          </div>
        )}
        <input
          className="note-title-input"
          value={title}
          placeholder="Title"
          readOnly={trashed}
          autoFocus={!trashed && !note.title}
          onChange={(e) => {
            setTitle(e.target.value)
            saveTitle(e.target.value)
          }}
          onBlur={() => title !== note.title && saveTitle(title, 0)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              bodyFocus.current()
            }
          }}
        />
        <div className="note-props">
          <select
            value={note.notebookId}
            disabled={trashed}
            title="Notebook"
            onChange={async (e) => {
              await store.moveNote(note.id, e.target.value)
              onPatch({ notebookId: e.target.value, updatedAt: Date.now() })
            }}
          >
            {notebooks.map((nb) => (
              <option key={nb.id} value={nb.id}>
                📒 {nb.name}
              </option>
            ))}
          </select>
          <TagPicker
            store={store}
            tags={tags}
            value={note.tagIds}
            disabled={trashed}
            onChange={async (tagIds: Id[], created: boolean) => {
              await store.setNoteTags(note.id, tagIds)
              onPatch({ tagIds, updatedAt: Date.now() })
              if (created) await onTagsCreated()
            }}
          />
          <span className="spacer" />
          <span className="dates" title={`Created ${new Date(note.createdAt).toLocaleString()}`}>
            Edited {formatWhen(note.updatedAt)}
          </span>
          {!trashed && (
            <ConfirmButton
              label="🗑"
              confirmLabel="Move to Trash?"
              title="Move to Trash"
              onConfirm={async () => {
                await store.trashNote(note.id)
                onRemoved()
              }}
            />
          )}
        </div>
      </div>
      {doc ? (
        <NoteBody store={store} noteId={note.id} doc={doc} readOnly={trashed} onPatch={onPatch} focusRef={bodyFocus} />
      ) : (
        <div className="note-body loading" />
      )}
    </div>
  )
}

function NoteBody({
  store,
  noteId,
  doc,
  readOnly,
  onPatch,
  focusRef,
}: {
  store: NoteStore
  noteId: Id
  doc: Y.Doc
  readOnly: boolean
  onPatch: (patch: Partial<NoteMeta>) => void
  focusRef: React.RefObject<() => void>
}) {
  // True once the user changes the document; Yjs/editor bookkeeping updates don't count as edits.
  const edited = useRef(false)
  const lastText = useRef<string | null>(null)
  const indexTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  // Persist Yjs updates in small batches.
  useEffect(() => {
    let pending: Uint8Array[] = []
    let timer: ReturnType<typeof setTimeout> | undefined
    const flush = () => {
      clearTimeout(timer)
      if (pending.length === 0) return
      const update = Y.mergeUpdates(pending)
      pending = []
      const touch = edited.current
      edited.current = false
      void store.appendNoteUpdate(noteId, update, touch)
      if (touch) onPatch({ updatedAt: Date.now() })
    }
    const onUpdate = (update: Uint8Array, origin: unknown) => {
      if (origin === LOAD_ORIGIN) return
      pending.push(update)
      clearTimeout(timer)
      timer = setTimeout(flush, SAVE_DELAY_MS)
    }
    doc.on('update', onUpdate)
    window.addEventListener('beforeunload', flush)
    return () => {
      doc.off('update', onUpdate)
      window.removeEventListener('beforeunload', flush)
      flush()
    }
    // onPatch identity changes with the parent's state; the latest is not needed for persistence.
  }, [store, noteId, doc])

  const extensions = useMemo(
    () =>
      noteExtensions({
        ydoc: doc,
        resolveImageSrc: (src) => {
          const hash = parseAttachmentRef(src)
          return hash ? store.attachmentUrl(hash) : src
        },
        paste: {
          storeImages: (files) =>
            Promise.all(
              files.map(async (f) => {
                const att = await store.putAttachment(new Uint8Array(await f.arrayBuffer()), f.type, f.name)
                return attachmentRef(att.hash)
              }),
            ),
        },
      }),
    [doc, store],
  )

  const indexNow = (text: string) => {
    if (text === lastText.current) return
    lastText.current = text
    void store.indexNoteText(noteId, text)
    onPatch({ snippet: text.replace(/\s+/g, ' ').trim().slice(0, 200) })
  }

  const editor = useEditor(
    {
      extensions,
      editable: !readOnly,
      onCreate: ({ editor }) => {
        lastText.current = editor.getText()
      },
      onUpdate: ({ editor, transaction }) => {
        if (!isChangeOrigin(transaction)) edited.current = true
        clearTimeout(indexTimer.current)
        indexTimer.current = setTimeout(() => indexNow(editor.getText()), INDEX_DELAY_MS)
      },
    },
    [extensions],
  )

  useEffect(() => {
    focusRef.current = () => {
      // TipTap's focus is deferred to the next frame; move DOM focus now so immediate typing lands in the body.
      editor.view.dom.focus()
      editor.commands.focus('start')
    }
  }, [editor, focusRef])

  // Flush a pending index update when leaving the note.
  useEffect(
    () => () => {
      if (indexTimer.current) {
        clearTimeout(indexTimer.current)
        if (!editor.isDestroyed) indexNow(editor.getText())
      }
    },
    [editor],
  )

  return (
    <>
      {!readOnly && <Toolbar editor={editor} />}
      <div className="note-body" onClick={(e) => e.target === e.currentTarget && editor.commands.focus('end')}>
        <EditorContent editor={editor} />
        {!readOnly && <SelectionFormatBar editor={editor} />}
      </div>
    </>
  )
}
