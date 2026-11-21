import { Editor, Node, mergeAttributes, type Extensions, type JSONContent } from '@tiptap/core'
import { Fragment } from '@tiptap/pm/model'
import type { EditorState } from '@tiptap/pm/state'

// A vault-encrypted section (docs/vault.md). The note itself only ever holds ciphertext in this atom's
// attributes, so sync, the server, backups and search never see the content. While the vault is open, the view
// decrypts it into an inner editor held in memory only, and re-encrypts the whole section (new IV) shortly
// after each edit. Unlocking and the crypto live in the app; this node talks to them through a VaultBridge.

export interface SectionAttrs {
  v: 1
  kid: string
  iv: string
  ct: string
}

export interface VaultBridge {
  isOpen(): boolean
  /** Asks for the passphrase (or to set up the vault). Resolves true once the vault is open. */
  open(): Promise<boolean>
  lock(): void
  /** Activity inside an open section, which postpones the auto-lock. */
  touch(): void
  /** Called whenever the vault opens or locks. */
  subscribe(listener: () => void): () => void
  /** Runs before the vault locks, so pending edits are saved while the key is still there. */
  beforeLock(flush: () => Promise<void>): () => void
  /** Encrypts with the section's key `kid`, or the vault's current key for a new section. */
  encrypt(content: JSONContent[], kid?: string): Promise<SectionAttrs>
  decrypt(attrs: SectionAttrs): Promise<JSONContent[]>
  /** The inner editor of an open section gained (or lost) focus, so the app's toolbar can act on it. */
  focusEditor?(editor: Editor | null): void
}

export interface VaultSectionOptions {
  bridge: VaultBridge | null
  /** The extensions for the inner editor: the note schema without sync. */
  innerExtensions: () => Extensions
}

/** Saves this long after typing stops. */
const SAVE_DELAY_MS = 800

export const VaultSection = Node.create<VaultSectionOptions>({
  name: 'vaultSection',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,

  addOptions() {
    return { bridge: null, innerExtensions: () => [] }
  },

  addAttributes() {
    const attr = (name: string) => ({ default: '', parseHTML: (el: HTMLElement) => el.getAttribute(`data-${name}`) ?? '' })
    return { v: { default: 1, parseHTML: () => 1 }, kid: attr('kid'), iv: attr('iv'), ct: attr('ct') }
  },

  parseHTML() {
    return [{ tag: 'div[data-type="vault-section"]' }]
  },

  renderHTML({ node, HTMLAttributes }) {
    const { kid, iv, ct } = node.attrs
    return [
      'div',
      mergeAttributes(HTMLAttributes, { 'data-type': 'vault-section', 'data-kid': kid, 'data-iv': iv, 'data-ct': ct, class: 'vault-section' }),
      '🔒 Encrypted section',
    ]
  },

  renderText() {
    return '' // never part of search, snippets or plain-text export
  },

  addNodeView() {
    const { bridge, innerExtensions } = this.options
    return ({ node: initial, getPos, editor: outer }) => {
      let node = initial
      let inner: Editor | null = null
      let dirty = false
      let saving: Promise<void> = Promise.resolve()
      let timer: ReturnType<typeof setTimeout> | undefined
      /** The ciphertext this view wrote last, to tell its own saves from changes from other devices. */
      let ownCt: string | null = null
      let error: string | null = null

      const dom = document.createElement('div')
      dom.className = 'vault-section'
      dom.dataset.type = 'vault-section'
      dom.contentEditable = 'false'
      const bar = document.createElement('div')
      bar.className = 'vault-section-bar'
      const body = document.createElement('div')
      body.className = 'vault-section-body'
      dom.append(bar, body)

      const button = (label: string, title: string, onClick: () => void, cls = '') => {
        const b = document.createElement('button')
        b.type = 'button'
        b.className = `vault-section-button ${cls}`.trim()
        b.textContent = label
        b.title = title
        b.addEventListener('mousedown', (e) => e.preventDefault())
        b.addEventListener('click', (e) => {
          e.preventDefault()
          onClick()
        })
        return b
      }

      const attrsOf = (n: typeof node) => n.attrs as SectionAttrs

      const save = () => {
        clearTimeout(timer)
        saving = saving.then(async () => {
          if (!dirty || !inner || !bridge?.isOpen()) return
          dirty = false
          const attrs = await bridge.encrypt(inner.getJSON().content ?? [], attrsOf(node).kid || undefined)
          const pos = typeof getPos === 'function' ? getPos() : undefined
          if (pos === undefined || outer.isDestroyed) return
          ownCt = attrs.ct
          // Not an undo step of the note: undo inside the section is the inner editor's own.
          outer.view.dispatch(outer.state.tr.setNodeMarkup(pos, undefined, attrs).setMeta('addToHistory', false))
        })
        return saving
      }

      const closeInner = () => {
        clearTimeout(timer)
        if (inner) {
          bridge?.focusEditor?.(null)
          inner.destroy()
          inner = null
        }
        body.replaceChildren()
      }

      const render = () => {
        const open = !!bridge?.isOpen()
        dom.classList.toggle('open', open && !!inner)
        bar.replaceChildren()
        const label = document.createElement('span')
        label.className = 'vault-section-label'
        label.textContent = error ? `🔒 ${error}` : '🔒 Encrypted section'
        bar.append(label)
        if (!bridge) return
        if (!inner) {
          bar.append(button('Show', 'Show this section (asks for the vault passphrase if it’s locked)', () => void show()))
          return
        }
        bar.append(button('Lock', 'Lock the vault: hides every encrypted section', () => bridge.lock()))
        if (outer.isEditable) {
          bar.append(button('Remove encryption', 'Turn this section back into normal, unencrypted text', () => void decryptInPlace(), 'danger'))
        }
      }

      const mountInner = async () => {
        if (!bridge) return
        let content: JSONContent[]
        try {
          content = await bridge.decrypt(attrsOf(node))
          error = null
        } catch (e) {
          error = e instanceof Error ? e.message : String(e)
          closeInner()
          render()
          return
        }
        closeInner()
        inner = new Editor({
          element: body,
          extensions: innerExtensions(),
          content: { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] },
          editable: outer.isEditable,
          onUpdate: () => {
            dirty = true
            bridge.touch()
            clearTimeout(timer)
            timer = setTimeout(() => void save(), SAVE_DELAY_MS)
          },
          onFocus: ({ editor }) => {
            bridge.touch()
            bridge.focusEditor?.(editor)
          },
          onBlur: () => void save(),
          onSelectionUpdate: () => bridge.touch(),
        })
        render()
      }

      const show = async () => {
        if (!bridge) return
        if (!bridge.isOpen() && !(await bridge.open())) return
        if (!inner) await mountInner()
        inner?.commands.focus('start')
      }

      const decryptInPlace = async () => {
        if (!inner) return
        await save()
        const pos = typeof getPos === 'function' ? getPos() : undefined
        if (pos === undefined) return
        const content = inner.getJSON().content ?? []
        const fragment = Fragment.fromJSON(outer.schema, content)
        outer.view.dispatch(outer.state.tr.replaceWith(pos, pos + node.nodeSize, fragment))
      }

      const onVaultChange = () => {
        if (bridge?.isOpen()) {
          // Opened elsewhere (another section, or the toolbar): show this one too.
          if (!inner) void mountInner()
        } else {
          closeInner()
          error = null
          render()
        }
      }
      const unsubscribe = bridge?.subscribe(onVaultChange)
      const unflush = bridge?.beforeLock(save)
      if (bridge?.isOpen()) void mountInner()
      else render()

      return {
        dom,
        update(updated) {
          if (updated.type !== node.type) return false
          const changed = attrsOf(updated).ct !== attrsOf(node).ct
          node = updated
          // A change from another device (or an undo of the note): show it unless there are unsaved edits here.
          if (changed && attrsOf(updated).ct !== ownCt && inner && !dirty) void mountInner()
          return true
        },
        // Typing, clicks and keys inside the section belong to the inner editor and the buttons.
        stopEvent: (event) => body.contains(event.target as globalThis.Node) || bar.contains(event.target as globalThis.Node),
        ignoreMutation: () => true,
        selectNode: () => dom.classList.add('selected'),
        deselectNode: () => dom.classList.remove('selected'),
        destroy() {
          void save()
          unsubscribe?.()
          unflush?.()
          closeInner()
        },
      }
    }
  },
})

/**
 * Why the current selection can't be encrypted, or null if it can. Attachments would stay readable on the
 * server, and sections don't nest.
 */
export function encryptionBlocker(state: EditorState): string | null {
  const { selection } = state
  if (selection.empty) return 'Select what to encrypt first.'
  let blocker: string | null = null
  selection.content().content.descendants((n) => {
    if (blocker) return false
    if (n.type.name === 'image') blocker = 'Move images out of the selection first: attachments can’t be encrypted.'
    else if (n.type.name === 'vaultSection' || n.type.name === 'evernoteEncrypted') blocker = 'The selection already contains an encrypted section.'
    else if (n.marks.some((m) => m.type.name === 'link' && String(m.attrs.href).startsWith('attachment:'))) {
      blocker = 'Move attached files out of the selection first: attachments can’t be encrypted.'
    }
    return true
  })
  if (blocker) return blocker
  try {
    state.schema.nodeFromJSON({ type: 'doc', content: selection.content().content.toJSON() }).check()
  } catch {
    return 'Select whole table rows or text inside a single cell.'
  }
  return null
}

/**
 * Replaces the selection with an encrypted section holding it. Opens (or sets up) the vault first if needed.
 * Returns a message when it can't, or null when done or cancelled.
 */
export async function encryptSelection(editor: Editor, bridge: VaultBridge): Promise<string | null> {
  const blocker = encryptionBlocker(editor.state)
  if (blocker) return blocker
  const before = editor.state
  const { from, to } = before.selection
  const content = before.selection.content().content.toJSON() as JSONContent[]
  if (!bridge.isOpen() && !(await bridge.open())) return null
  if (editor.isDestroyed) return null
  if (editor.state.doc !== before.doc) return 'The note changed meanwhile. Select the text again.'
  const attrs = await bridge.encrypt(content)
  if (editor.state.doc !== before.doc) return 'The note changed meanwhile. Select the text again.'
  const section = editor.schema.nodes.vaultSection.create(attrs)
  editor.view.dispatch(editor.state.tr.replaceRangeWith(from, to, section).scrollIntoView())
  bridge.touch()
  return null
}
