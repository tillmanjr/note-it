import { Node, mergeAttributes } from '@tiptap/core'

// Text encrypted in Evernote ("Encrypt selected text"), imported unchanged. The ciphertext is kept
// verbatim so it can later be unlocked with the old Evernote passphrase and re-encrypted under the
// vault (milestone 2d). It is never decrypted on import and is excluded from search.

export const EvernoteEncrypted = Node.create({
  name: 'evernoteEncrypted',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      cipher: { default: 'AES', parseHTML: (el) => el.getAttribute('data-cipher') },
      length: { default: null, parseHTML: (el) => el.getAttribute('data-length') },
      hint: { default: null, parseHTML: (el) => el.getAttribute('data-hint') },
      data: { default: '', parseHTML: (el) => el.getAttribute('data-ciphertext') ?? '' },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-type="evernote-encrypted"]' }]
  },

  renderHTML({ node, HTMLAttributes }) {
    const { cipher, length, hint, data } = node.attrs
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-type': 'evernote-encrypted',
        'data-cipher': cipher,
        'data-length': length,
        'data-hint': hint,
        'data-ciphertext': data,
        class: 'evernote-encrypted',
      }),
      `🔒 Encrypted text from Evernote${hint ? ` (hint: ${hint})` : ''}`,
    ]
  },

  renderText() {
    // Keep encrypted content out of the plain-text projection (search index, snippets).
    return ''
  },
})
