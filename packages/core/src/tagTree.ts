import type { Id, Tag } from './model'

// Hierarchical tags: each tag has an optional parent. Tags are independent of notebooks.

export interface TagNode {
  tag: Tag
  children: TagNode[]
}

/** A tag name as stored: leading "+" and surrounding whitespace are dropped, silently. Empty if nothing is left. */
export function cleanTagName(name: string): string {
  return name.replace(/^[\s+]+/, '').trim()
}

/** Splits a path like "projects/house" into cleaned levels. A leading "#" is a prompt; empty levels are dropped. */
export function splitTagPath(path: string): string[] {
  return path
    .replace(/^[\s#]+/, '')
    .split('/')
    .map(cleanTagName)
    .filter(Boolean)
}

/** Tag names compare case-insensitively ("Projects" and "projects" are the same tag). */
export function sameTagName(a: string, b: string): boolean {
  return a.localeCompare(b, undefined, { sensitivity: 'base' }) === 0
}

const byName =(a: TagNode, b: TagNode) => a.tag.name.localeCompare(b.tag.name, undefined, { sensitivity: 'base' })

/** Live tags as a sorted forest. Tags whose parent is missing or deleted become roots. */
export function buildTagTree(tags: Tag[]): TagNode[] {
  const live = tags.filter((t) => t.deletedAt === null)
  const nodes = new Map<Id, TagNode>(live.map((t) => [t.id, { tag: t, children: [] }]))
  const roots: TagNode[] = []
  for (const node of nodes.values()) {
    const parent = node.tag.parentId ? nodes.get(node.tag.parentId) : undefined
    ;(parent ? parent.children : roots).push(node)
  }
  const sort = (list: TagNode[]) => {
    list.sort(byName)
    list.forEach((n) => sort(n.children))
  }
  sort(roots)
  return roots
}

/** The tag and all of its descendants (live tags only). */
export function descendantTagIds(tags: Tag[], id: Id): Id[] {
  const children = new Map<Id, Id[]>()
  for (const t of tags) {
    if (t.deletedAt !== null || !t.parentId) continue
    children.set(t.parentId, [...(children.get(t.parentId) ?? []), t.id])
  }
  const out: Id[] = []
  const stack = [id]
  while (stack.length) {
    const next = stack.pop()!
    if (out.includes(next)) continue
    out.push(next)
    stack.push(...(children.get(next) ?? []))
  }
  return out
}

/** "parent/child/grandchild" for display and import matching. */
export function tagPath(tags: Tag[], id: Id): string {
  const byId = new Map(tags.map((t) => [t.id, t]))
  const parts: string[] = []
  const seen = new Set<Id>()
  let cur = byId.get(id)
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    parts.unshift(cur.name)
    cur = cur.parentId ? byId.get(cur.parentId) : undefined
  }
  return parts.join('/')
}

/** True if making `newParentId` the parent of `id` would create a cycle. */
export function wouldCreateCycle(tags: Tag[], id: Id, newParentId: Id | null): boolean {
  if (newParentId === null) return false
  return descendantTagIds(tags, id).includes(newParentId)
}
