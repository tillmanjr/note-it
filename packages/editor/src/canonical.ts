import type { JSONContent } from '@tiptap/core'

// TipTap's text-style attributes use both `null` and `""` for "unset" depending on
// whether the value came from a command or from parsed HTML. Canonicalize before
// storing or comparing documents so equal content serializes identically.
export function canonicalize(node: JSONContent): JSONContent {
  const out: JSONContent = { ...node }
  if (node.attrs) out.attrs = canonicalAttrs(node.attrs)
  if (node.marks) out.marks = node.marks.map((m) => (m.attrs ? { ...m, attrs: canonicalAttrs(m.attrs) } : m))
  if (node.content) out.content = node.content.map(canonicalize)
  return out
}

function canonicalAttrs(attrs: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k, v === '' ? null : v]))
}
