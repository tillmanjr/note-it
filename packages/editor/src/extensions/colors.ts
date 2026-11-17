import { getStyleProperty, isValidCSSStyleValue } from '@tiptap/core'
import { BackgroundColor, Color } from '@tiptap/extension-text-style'
import { CONTRAST_MAX, CONTRAST_MIN } from '../formatting'

// ProseMirror serializes `style` via dom.style.cssText, so the browser rewrites
// `#c0392b` to `rgb(192, 57, 43)` on the way out. Storing every color as
// lowercase hex at parse time keeps JSON → HTML → JSON lossless.

export function toHexColor(value: string | null | undefined): string | null {
  if (!value) return null
  const v = value.replace(/['"]+/g, '').trim().toLowerCase()
  if (v === 'transparent' || v === 'inherit' || v === 'initial') return null
  // Theme-aware contrast colors keep one canonical spelling whatever the browser serializes.
  const contrast = v.match(/^var\(\s*--note-(max|min)\b/)
  if (contrast) return contrast[1] === 'max' ? CONTRAST_MAX : CONTRAST_MIN
  const short = v.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/)
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`
  if (/^#[0-9a-f]{6}$/.test(v)) return v
  const rgb = v.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+%?))?\s*\)$/)
  if (rgb) {
    // Fully transparent backgrounds (common in pasted HTML) mean "no color".
    if (rgb[4] !== undefined && parseFloat(rgb[4]) === 0) return null
    return '#' + [rgb[1], rgb[2], rgb[3]].map((n) => Math.min(255, parseInt(n, 10)).toString(16).padStart(2, '0')).join('')
  }
  // Named colors and anything else pass through unchanged (they round-trip as-is).
  return v || null
}

const canonicalAttribute = (cssProperty: string, attrName: string) => ({
  default: null,
  parseHTML: (element: HTMLElement) => toHexColor(getStyleProperty(element, cssProperty)),
  renderHTML: (attributes: Record<string, string | null>) =>
    isValidCSSStyleValue(attributes[attrName]) ? { style: `${cssProperty}: ${attributes[attrName]}` } : {},
})

export const CanonicalColor = Color.extend({
  addGlobalAttributes() {
    return [{ types: this.options.types, attributes: { color: canonicalAttribute('color', 'color') } }]
  },
  addCommands() {
    return {
      ...this.parent?.(),
      setColor:
        (color) =>
        ({ chain }) =>
          chain().setMark('textStyle', { color: toHexColor(color) }).removeEmptyTextStyle().run(),
    }
  },
})

export const CanonicalBackgroundColor = BackgroundColor.extend({
  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: { backgroundColor: canonicalAttribute('background-color', 'backgroundColor') },
      },
    ]
  },
  addCommands() {
    return {
      ...this.parent?.(),
      setBackgroundColor:
        (backgroundColor) =>
        ({ chain }) =>
          chain().setMark('textStyle', { backgroundColor: toHexColor(backgroundColor) }).removeEmptyTextStyle().run(),
    }
  },
})
