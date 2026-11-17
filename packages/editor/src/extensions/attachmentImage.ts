import Image, { type ImageOptions } from '@tiptap/extension-image'

// Images whose `src` may be an attachment reference (`attachment:<sha256>`). The document keeps the
// reference (portable across devices and sync); only the on-screen <img> gets a resolved local URL.

export interface AttachmentImageOptions extends ImageOptions {
  resolveSrc: (src: string) => string
}

export const AttachmentImage = Image.extend<AttachmentImageOptions>({
  addOptions() {
    return { ...this.parent!(), resolveSrc: (src: string) => src }
  },

  addNodeView() {
    const resolve = this.options.resolveSrc
    return ({ node, HTMLAttributes }) => {
      const img = document.createElement('img')
      const apply = (attrs: Record<string, unknown>) => {
        for (const key of ['alt', 'title', 'width', 'height']) {
          const v = attrs[key]
          if (v == null) img.removeAttribute(key)
          else img.setAttribute(key, String(v))
        }
        const src = attrs.src as string | null
        if (src) img.src = resolve(src)
        else img.removeAttribute('src')
      }
      apply(HTMLAttributes)
      return {
        dom: img,
        update: (updated) => {
          if (updated.type !== node.type) return false
          apply(updated.attrs)
          return true
        },
      }
    }
  },
})
