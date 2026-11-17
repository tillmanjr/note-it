import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'

// Paste fidelity: the "web clipper" is copy/paste from a browser, so pasted HTML is
// cleaned up before ProseMirror parses it against the schema, and pasted/dropped
// image files are embedded.

export interface PasteOptions {
  /** Called with the raw clipboard HTML, for inspecting what sources actually send. */
  onRawHtml?: (html: string) => void
  /** Stores pasted/dropped image files and returns the `src` for each. Default: inline data URLs. */
  storeImages?: (files: File[]) => Promise<string[]>
}

export function cleanPastedHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')

  doc.querySelectorAll('script, style, meta, link, noscript, iframe, object, embed').forEach((el) => el.remove())

  // Google Docs wraps the whole clipboard payload in <b style="font-weight:normal">, which would bold everything.
  doc.querySelectorAll('b[id^="docs-internal-guid"]').forEach((b) => b.replaceWith(...Array.from(b.childNodes)))

  // Spans styled as bold/italic/underline (Google Docs, many CMSes) become real marks.
  doc.querySelectorAll<HTMLElement>('span[style]').forEach((span) => {
    const s = span.style
    let wrapped: Node = span
    const wrap = (tag: string) => {
      const el = doc.createElement(tag)
      wrapped.parentNode?.replaceChild(el, wrapped)
      el.appendChild(wrapped)
      wrapped = el
    }
    const weight = s.fontWeight
    const decoration = `${s.textDecoration} ${s.textDecorationLine}`
    if (weight === 'bold' || parseInt(weight, 10) >= 600) wrap('strong')
    if (s.fontStyle === 'italic') wrap('em')
    if (decoration.includes('underline')) wrap('u')
    if (decoration.includes('line-through')) wrap('s')

    // Keep only styles the schema represents; otherwise TextStyle turns every styled span into an empty mark.
    const kept = ['color', 'background-color', 'font-family', 'font-size']
      .map((prop) => [prop, s.getPropertyValue(prop)] as const)
      .filter(([, v]) => v && v !== 'inherit' && v !== 'initial')
    if (kept.length === 0) span.replaceWith(...Array.from(span.childNodes))
    else span.setAttribute('style', kept.map(([p, v]) => `${p}: ${v}`).join('; '))
  })

  // Drop tracking pixels and empty images.
  doc.querySelectorAll('img').forEach((img) => {
    const w = img.getAttribute('width')
    const h = img.getAttribute('height')
    if (!img.getAttribute('src') || (w === '1' && h === '1')) img.remove()
  })

  return doc.body.innerHTML
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
}

export const Paste = Extension.create<PasteOptions>({
  name: 'pasteFidelity',

  addOptions() {
    return { onRawHtml: undefined, storeImages: undefined }
  },

  addProseMirrorPlugins() {
    const { onRawHtml } = this.options
    const storeImages = this.options.storeImages ?? ((files: File[]) => Promise.all(files.map(readAsDataUrl)))
    const editor = this.editor

    const insertImageFiles = (files: File[], pos?: number) => {
      const images = files.filter((f) => f.type.startsWith('image/'))
      if (images.length === 0) return false
      void storeImages(images).then((srcs) => {
        const chain = editor.chain().focus()
        if (pos !== undefined) chain.setTextSelection(pos)
        chain.insertContent(srcs.map((src) => ({ type: 'image', attrs: { src } }))).run()
      })
      return true
    }

    return [
      new Plugin({
        key: new PluginKey('pasteFidelity'),
        props: {
          transformPastedHTML: (html) => {
            onRawHtml?.(html)
            return cleanPastedHtml(html)
          },
          handlePaste: (_view, event) => {
            const data = event.clipboardData
            if (!data) return false
            // Prefer HTML when present (a copied web selection carries both HTML and image files).
            if (data.getData('text/html')) return false
            return insertImageFiles(Array.from(data.files))
          },
          handleDrop: (view, event) => {
            const files = Array.from(event.dataTransfer?.files ?? [])
            if (files.length === 0) return false
            const coords = view.posAtCoords({ left: event.clientX, top: event.clientY })
            event.preventDefault()
            return insertImageFiles(files, coords?.pos)
          },
        },
      }),
    ]
  },
})
