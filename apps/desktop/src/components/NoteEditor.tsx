import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import * as Y from 'yjs'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import { Selection } from '@tiptap/pm/state'
import { attachmentRef, parseAttachmentRef, type Id, type NoteMeta, type NoteStore, type Notebook, type Tag } from '@tdjr/core'
import { isChangeOrigin, noteExtensions, SelectionFormatBar, Toolbar } from '@tdjr/editor'
import { TagPicker } from './TagPicker'
import { ConfirmButton } from './controls'
import { formatWhen } from './NoteList'

const LOAD_ORIGIN = 'load'
/** Updates synced from another device: already stored, so not saved again. */
const REMOTE_ORIGIN = 'remote'
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

// One instance per open note (keyed by id in the parent). The toolbar sits on top, the title is the first line
// of the scrolling note, and the note's details sit in a strip fixed to the bottom.
export function NoteEditor({ store, note, notebooks, tags, onPatch, onTagsCreated, onRemoved }: Props) {
  const [doc, setDoc] = useState<Y.Doc | null>(null)
  const [editor, setEditor] = useState<Editor | null>(null)
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

  // Edits to this note from another device merge into the open document.
  useEffect(() => {
    if (!doc) return
    return store.onChange((e) => {
      if (e.type !== 'remote') return
      for (const update of e.bodies.get(note.id) ?? []) Y.applyUpdate(doc, update, REMOTE_ORIGIN)
    })
  }, [store, note.id, doc])

  // A title changed on another device shows up here, unless the title is being edited.
  const titleInput = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (document.activeElement !== titleInput.current) setTitle(note.title)
  }, [note.title])

  // The title wraps like a line of text: the field grows to fit it.
  useLayoutEffect(() => {
    const el = titleInput.current
    if (!el) return
    const fit = () => {
      el.style.height = 'auto'
      el.style.height = `${el.scrollHeight}px`
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(el)
    return () => observer.disconnect()
  }, [title])

  const focusTitleEnd = () => {
    const el = titleInput.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }

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
      {!trashed && (editor ? <Toolbar editor={editor} /> : <div className="toolbar toolbar-placeholder" />)}
      <div className="note-body" onClick={(e) => e.target === e.currentTarget && editor?.commands.focus('end')}>
        <textarea
          ref={titleInput}
          className="note-title-input"
          value={title}
          rows={1}
          placeholder="Title"
          readOnly={trashed}
          autoFocus={!trashed && !note.title}
          spellCheck
          onChange={(e) => {
            // A title is one line, even when pasted.
            const value = e.target.value.replace(/[\r\n]+/g, ' ')
            setTitle(value)
            saveTitle(value)
          }}
          onBlur={() => title !== note.title && saveTitle(title, 0)}
          onKeyDown={(e) => {
            const el = e.currentTarget
            const atEnd = el.selectionStart === el.value.length && el.selectionEnd === el.value.length
            // Leaving the title moves into the note, as if the title were its first line.
            if (e.key === 'Enter' || e.key === 'ArrowDown' || (e.key === 'ArrowRight' && atEnd)) {
              e.preventDefault()
              bodyFocus.current()
            }
          }}
        />
        {doc ? (
          <NoteBody
            store={store}
            noteId={note.id}
            doc={doc}
            readOnly={trashed}
            onPatch={onPatch}
            focusRef={bodyFocus}
            onExitTop={focusTitleEnd}
            onEditor={setEditor}
          />
        ) : (
          <div className="loading" />
        )}
      </div>
      <footer className="note-footer">
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
        {/* Floats: the notebook pins left and this pins right; tags flow between them and wrap below at full width. */}
        <span className="note-footer-end">
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
        </span>
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
      </footer>
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
  onExitTop,
  onEditor,
}: {
  store: NoteStore
  noteId: Id
  doc: Y.Doc
  readOnly: boolean
  onPatch: (patch: Partial<NoteMeta>) => void
  focusRef: React.RefObject<() => void>
  /** Called when the caret leaves the top of the note (up, left or backspace at the very start). */
  onExitTop: () => void
  onEditor: (editor: Editor | null) => void
}) {
  // True once the user changes the document; Yjs/editor bookkeeping updates don't count as edits.
  const edited = useRef(false)
  const lastText = useRef<string | null>(null)
  const indexTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const exitTop = useRef(onExitTop)
  exitTop.current = onExitTop

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
      if (origin === LOAD_ORIGIN || origin === REMOTE_ORIGIN) return
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
      editorProps: {
        // The title acts as the line above the first one: moving up or back from the very start goes there.
        handleKeyDown: (view, event) => {
          if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return false
          const { selection, doc: pm } = view.state
          if (!selection.empty) return false
          const $head = selection.$head
          const inFirstBlock = $head.start() === Selection.atStart(pm).$head.start()
          if (!inFirstBlock) return false
          const atStart = $head.parentOffset === 0
          const leave =
            (event.key === 'ArrowUp' && view.endOfTextblock('up')) ||
            (event.key === 'ArrowLeft' && atStart) ||
            // Only a plain top-level line: elsewhere Backspace at the start has its own job (e.g. leaving a list).
            (event.key === 'Backspace' && atStart && $head.depth === 1)
          if (!leave) return false
          event.preventDefault()
          exitTop.current()
          return true
        },
      },
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
    onEditor(editor)
    return () => onEditor(null)
  }, [editor, onEditor])

  useEffect(() => {
    focusRef.current = () => {
      // Synchronous, unlike TipTap's focus(), which waits a frame: keys typed right away land in the body,
      // and a quick Backspace back to the title isn't undone by a late focus.
      const { view } = editor
      view.dispatch(view.state.tr.setSelection(Selection.atStart(view.state.doc)).scrollIntoView())
      view.focus()
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
      <EditorContent editor={editor} />
      {!readOnly && <SelectionFormatBar editor={editor} />}
    </>
  )
}
