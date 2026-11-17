import { cleanPastedHtml } from '@tdjr/editor'

// ENML → HTML in the shape the note schema parses (see @tdjr/editor). Evernote-specific
// constructs are rewritten first; the result then goes through the same cleanup as pasted HTML.

export interface MediaRef {
  /** `src`/`href` to use in the note, e.g. `attachment:<sha256>`. */
  ref: string
  mime: string
  fileName: string | null
  /** 1×1 spacer/tracking image from a web clip: dropped. */
  spacer?: boolean
}

export interface EnmlStats {
  images: number
  files: number
  missingMedia: number
  checklistItems: number
  encrypted: number
  tables: number
  remoteImages: number
}

const INDENT_PX = 40
const MONO_FAMILY = /mono|courier|consolas|menlo|monaco/i
const BLOCK_TAGS = new Set([
  'div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tfoot', 'tr',
  'td', 'th', 'blockquote', 'pre', 'hr', 'dl', 'dt', 'dd', 'section', 'article', 'header', 'footer', 'center',
])
const TEXT_BLOCKS = 'p, h1, h2, h3, h4, h5, h6, pre'
const VOID_TAGS = new Set(['br', 'hr', 'img', 'col', 'area', 'base', 'input', 'link', 'meta', 'source', 'track', 'wbr'])
/** <font size=N> → px. */
const FONT_SIZES: Record<string, string> = { '1': '10px', '2': '13px', '3': '16px', '4': '18px', '5': '24px', '6': '32px', '7': '48px' }

const isBlock = (n: Node): boolean => n.nodeType === 1 && BLOCK_TAGS.has((n as Element).tagName.toLowerCase())
const tag = (el: Element) => el.tagName.toLowerCase()

function parseLength(value: string): number {
  const m = value.trim().match(/^(-?[\d.]+)(px|em|rem|pt)?$/)
  if (!m) return 0
  const n = parseFloat(m[1])
  return m[2] === 'em' || m[2] === 'rem' ? n * 16 : m[2] === 'pt' ? (n * 4) / 3 : n
}

/** Left offset from margin-left / padding-left, including the `margin` shorthand. */
function leftOffset(el: HTMLElement): number {
  const s = el.style
  let margin = parseLength(s.marginLeft || '')
  if (!margin && s.margin) {
    const parts = s.margin.trim().split(/\s+/)
    margin = parseLength(parts.length === 4 ? parts[3] : parts.length >= 2 ? parts[1] : parts[0])
  }
  return Math.max(margin, parseLength(s.paddingLeft || ''))
}

/** Evernote's indent: a borderless blockquote with a left margin (nested once per level). */
function isIndentBlockquote(el: HTMLElement): boolean {
  if (tag(el) !== 'blockquote') return false
  const border = `${el.style.border} ${el.style.borderLeft} ${el.style.borderStyle}`
  const borderless = /none|^\s*$/.test(border.trim()) || border.includes('none')
  return borderless && leftOffset(el) > 0
}

const styleHas = (el: Element, prop: string, value: string) =>
  new RegExp(`${prop}\\s*:\\s*${value}`, 'i').test(el.getAttribute('style') ?? '')

/** Moves an element's children into its place. */
function unwrap(el: Element) {
  el.replaceWith(...Array.from(el.childNodes))
}

/** Wraps each run of inline children of `el` in a new element of type `wrapper`. */
function wrapInlineRuns(el: Element, wrapper: string, init?: (w: HTMLElement) => void) {
  const doc = el.ownerDocument
  let run: Node[] = []
  const flush = (before: Node | null) => {
    if (run.some((n) => n.nodeType !== 3 || (n.textContent ?? '').trim() !== '' || (n as Element).tagName)) {
      const w = doc.createElement(wrapper)
      init?.(w)
      el.insertBefore(w, before)
      run.forEach((n) => w.appendChild(n))
    }
    run = []
  }
  for (const child of Array.from(el.childNodes)) {
    if (isBlock(child)) flush(child)
    else run.push(child)
  }
  flush(null)
}

/** Expands XHTML self-closing tags so the HTML parser doesn't swallow following content. */
function expandSelfClosing(enml: string): string {
  return enml.replace(/<([a-zA-Z][\w-]*)([^<>]*?)\s*\/>/g, (whole, name: string, attrs: string) =>
    VOID_TAGS.has(name.toLowerCase()) ? whole : `<${name}${attrs}></${name}>`,
  )
}

export function enmlToHtml(enml: string, media: Map<string, MediaRef>): { html: string; stats: EnmlStats } {
  const stats: EnmlStats = { images: 0, files: 0, missingMedia: 0, checklistItems: 0, encrypted: 0, tables: 0, remoteImages: 0 }
  const body = enml.replace(/<\?xml[^>]*\?>/g, '').replace(/<!DOCTYPE[^>]*>/gi, '')
  const doc = new DOMParser().parseFromString(`<body>${expandSelfClosing(body)}</body>`, 'text/html')
  const root = doc.body
  root.querySelectorAll('en-note').forEach(unwrap)

  // Attachments.
  root.querySelectorAll('en-media').forEach((el) => {
    const ref = media.get((el.getAttribute('hash') ?? '').toLowerCase())
    if (!ref) {
      // Evernote sometimes omits a resource from its own export; leave a visible marker.
      stats.missingMedia++
      const p = doc.createElement('p')
      p.textContent = '⚠ Attachment missing from the Evernote export'
      el.replaceWith(p)
      return
    }
    if (ref.spacer) {
      el.remove()
      return
    }
    if (ref.mime.startsWith('image/')) {
      stats.images++
      const img = doc.createElement('img')
      img.setAttribute('src', ref.ref)
      if (ref.fileName) img.setAttribute('alt', ref.fileName)
      el.replaceWith(img)
    } else {
      stats.files++
      const p = doc.createElement('p')
      const a = doc.createElement('a')
      a.setAttribute('href', ref.ref)
      a.textContent = `📎 ${ref.fileName ?? ref.mime}`
      p.appendChild(a)
      el.replaceWith(p)
    }
  })
  stats.remoteImages = Array.from(root.querySelectorAll('img')).filter((img) => /^https?:/i.test(img.getAttribute('src') ?? '')).length

  // Encrypted text: keep the ciphertext verbatim.
  root.querySelectorAll('en-crypt').forEach((el) => {
    stats.encrypted++
    const div = doc.createElement('div')
    div.setAttribute('data-type', 'evernote-encrypted')
    div.setAttribute('data-cipher', el.getAttribute('cipher') ?? 'AES')
    if (el.getAttribute('length')) div.setAttribute('data-length', el.getAttribute('length')!)
    if (el.getAttribute('hint')) div.setAttribute('data-hint', el.getAttribute('hint')!)
    div.setAttribute('data-ciphertext', (el.textContent ?? '').trim())
    el.replaceWith(div)
  })

  // Checklists, current format: <ul style="--en-todo:true"><li style="--en-checked:true">.
  root.querySelectorAll('ul').forEach((ul) => {
    if (!styleHas(ul, '--en-todo', 'true')) return
    ul.setAttribute('data-type', 'taskList')
    ul.removeAttribute('style')
    Array.from(ul.children).forEach((li) => {
      if (tag(li) !== 'li') return
      stats.checklistItems++
      li.setAttribute('data-type', 'taskItem')
      li.setAttribute('data-checked', String(styleHas(li, '--en-checked', 'true')))
      li.removeAttribute('style')
      wrapInlineRuns(li, 'p')
    })
  })

  // Checklists, legacy format: a block starting with <en-todo checked="true"/>.
  root.querySelectorAll('en-todo').forEach((todo) => {
    let block: Element | null = todo.parentElement
    while (block && block !== root && !isBlock(block)) block = block.parentElement
    if (!block || block === root) {
      // Bare todo at top level: give it its own block.
      block = doc.createElement('div')
      todo.before(block)
      let next = todo.nextSibling
      block.appendChild(todo)
      while (next && !isBlock(next) && tag(next as Element) !== 'en-todo') {
        const after = next.nextSibling
        block.appendChild(next)
        next = after
      }
    }
    block.setAttribute('data-todo', todo.getAttribute('checked') === 'true' ? 'true' : 'false')
    todo.remove()
  })
  const todoBlocks = Array.from(root.querySelectorAll('[data-todo]'))
  for (const block of todoBlocks) {
    if (!block.isConnected) continue
    const ul = doc.createElement('ul')
    ul.setAttribute('data-type', 'taskList')
    block.before(ul)
    let cur: Element | null = block
    while (cur && cur.hasAttribute('data-todo')) {
      const next: Element | null = cur.nextElementSibling
      const li = doc.createElement('li')
      li.setAttribute('data-type', 'taskItem')
      li.setAttribute('data-checked', cur.getAttribute('data-todo')!)
      const p = doc.createElement('p')
      p.append(...Array.from(cur.childNodes))
      li.appendChild(p)
      ul.appendChild(li)
      cur.remove()
      stats.checklistItems++
      cur = next
    }
  }

  // <font> → <span style>.
  root.querySelectorAll('font').forEach((font) => {
    const span = doc.createElement('span')
    const styles: string[] = []
    if (font.getAttribute('face')) styles.push(`font-family: ${font.getAttribute('face')}`)
    if (font.getAttribute('color')) styles.push(`color: ${font.getAttribute('color')}`)
    const size = FONT_SIZES[font.getAttribute('size') ?? '']
    if (size) styles.push(`font-size: ${size}`)
    if (font.getAttribute('style')) styles.push(font.getAttribute('style')!)
    span.setAttribute('style', styles.join('; '))
    span.append(...Array.from(font.childNodes))
    font.replaceWith(span)
  })

  // Indentation: borderless blockquotes become indent levels on the blocks inside them.
  const indentQuotes = Array.from(root.querySelectorAll<HTMLElement>('blockquote')).filter(isIndentBlockquote)
  indentQuotes.forEach((bq) => wrapInlineRuns(bq, 'div'))
  const quoteSet = new Set<Element>(indentQuotes)
  root.querySelectorAll<HTMLElement>(`div, ${TEXT_BLOCKS}, ul, ol, table`).forEach((el) => {
    let depth = 0
    for (let a = el.parentElement; a && a !== root; a = a.parentElement) if (quoteSet.has(a)) depth++
    if (depth) el.setAttribute('data-bq-indent', String(depth))
  })
  indentQuotes.reverse().forEach(unwrap)

  // Lists/tables directly inside an indent keep their position via a wrapping indent on their text blocks.
  root.querySelectorAll<HTMLElement>('ul[data-bq-indent], ol[data-bq-indent], table[data-bq-indent]').forEach((el) => {
    const depth = el.getAttribute('data-bq-indent')!
    el.querySelectorAll<HTMLElement>(`div, ${TEXT_BLOCKS}`).forEach((b) => {
      if (!b.hasAttribute('data-bq-indent')) b.setAttribute('data-bq-indent', depth)
    })
  })

  // Divs: inline-only divs become paragraphs; divs holding blocks are unwrapped (inline runs become paragraphs).
  const divs = Array.from(root.querySelectorAll<HTMLElement>('div')).reverse()
  for (const div of divs) {
    if (div.getAttribute('data-type')) continue // encrypted placeholder etc.
    const carry = (to: HTMLElement) => {
      for (const attr of ['style', 'data-bq-indent', 'align']) {
        const v = div.getAttribute(attr)
        if (v !== null && !to.hasAttribute(attr)) to.setAttribute(attr, v)
      }
    }
    if (Array.from(div.childNodes).some(isBlock)) {
      wrapInlineRuns(div, 'p', carry)
      unwrap(div)
    } else {
      const p = doc.createElement('p')
      carry(p)
      p.append(...Array.from(div.childNodes))
      div.replaceWith(p)
    }
  }

  // Inline content left directly at the top level becomes paragraphs.
  wrapInlineRuns(root, 'p')

  // Text blocks: final indent level, alignment, monospace, and trailing <br> cleanup.
  root.querySelectorAll<HTMLElement>(TEXT_BLOCKS).forEach((block) => {
    const level = Number(block.getAttribute('data-bq-indent') ?? 0) + Math.round(leftOffset(block) / INDENT_PX)
    block.removeAttribute('data-bq-indent')
    if (level > 0) block.setAttribute('data-indent', String(Math.min(level, 12)))
    const align = block.getAttribute('align')
    if (align && !block.style.textAlign) block.style.textAlign = align
    block.removeAttribute('align')

    // A <br> at the very end of a block only gives an empty block height in Evernote.
    while (block.lastChild && block.lastChild.nodeName === 'BR' && block.childNodes.length > 1) block.lastChild.remove()

    if (tag(block) === 'p') markMonospace(block)
  })
  root.querySelectorAll('[data-bq-indent]').forEach((el) => el.removeAttribute('data-bq-indent'))
  stats.tables = root.querySelectorAll('table').length

  return { html: cleanPastedHtml(root.innerHTML), stats }
}

/** A paragraph whose text is entirely in a fixed-width font becomes a Monospaced paragraph. */
function markMonospace(p: HTMLElement) {
  const texts: Text[] = []
  const walker = p.ownerDocument.createTreeWalker(p, 4 /* NodeFilter.SHOW_TEXT */)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if ((n.textContent ?? '').trim()) texts.push(n as Text)
  if (texts.length === 0) return
  const monoAncestor = (t: Text): HTMLElement | null => {
    for (let el = t.parentElement; el; el = el.parentElement) {
      if (MONO_FAMILY.test(el.style?.fontFamily ?? '')) return el
      if (el === p) break
    }
    return null
  }
  const owners = texts.map(monoAncestor)
  if (owners.some((o) => o === null)) return
  p.setAttribute('data-monospace', '')
  for (const el of new Set(owners as HTMLElement[])) el.style.removeProperty('font-family')
}
