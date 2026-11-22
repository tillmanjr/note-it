import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { Id } from '@tdjr/core'

/** Where a dragged tag would go: under another tag, or to the top level (dropped on the Tags heading). */
export type TagDropTarget = Id | 'top'

export interface TagDrag {
  id: Id
  x: number
  y: number
  target: TagDropTarget | null
}

/** Pixels the pointer must travel before a press on a tag row becomes a drag (so clicks stay clicks). */
const THRESHOLD = 5

/**
 * Drag a tag row onto another tag row (`data-tag-id`) or onto the Tags heading (`data-tag-drop="top"`).
 * Pointer events rather than HTML drag and drop, which the desktop webview reserves for dropped files.
 * Mouse and pen only: on touch screens a press-and-move scrolls the list, and the path edit moves tags instead.
 */
export function useTagDrag(canDrop: (id: Id, target: TagDropTarget) => boolean, onDrop: (id: Id, target: TagDropTarget) => void) {
  const [drag, setDrag] = useState<TagDrag | null>(null)
  const handlers = useRef({ canDrop, onDrop })
  handlers.current = { canDrop, onDrop }
  const cleanup = useRef<() => void>(() => {})
  useEffect(() => () => cleanup.current(), [])

  const start = (id: Id, e: ReactPointerEvent) => {
    if (e.pointerType === 'touch' || e.button !== 0) return
    if ((e.target as HTMLElement).closest('button, input')) return
    const x0 = e.clientX
    const y0 = e.clientY
    let current: TagDrag | null = null

    const targetAt = (x: number, y: number): TagDropTarget | null => {
      const el = document.elementFromPoint(x, y)
      const row = el?.closest<HTMLElement>('[data-tag-id]')
      // The marker sits in the heading's title; anywhere on that heading counts.
      const top = el?.closest('[data-tag-drop="top"]') ?? el?.closest('.section-head')?.querySelector('[data-tag-drop="top"]')
      const target: TagDropTarget | null = row ? row.dataset.tagId! : top ? 'top' : null
      return target !== null && handlers.current.canDrop(id, target) ? target : null
    }
    const move = (ev: PointerEvent) => {
      if (!current && Math.hypot(ev.clientX - x0, ev.clientY - y0) < THRESHOLD) return
      if (!current) {
        document.getSelection()?.removeAllRanges()
        document.body.classList.add('dragging-tag')
      }
      current = { id, x: ev.clientX, y: ev.clientY, target: targetAt(ev.clientX, ev.clientY) }
      setDrag(current)
    }
    // The click that ends a drag must not also select the row it was dropped on.
    const swallowClick = (ev: MouseEvent) => {
      ev.stopPropagation()
      ev.preventDefault()
    }
    const up = () => {
      const done = current
      cleanup.current()
      if (!done) return
      window.addEventListener('click', swallowClick, { capture: true, once: true })
      setTimeout(() => window.removeEventListener('click', swallowClick, { capture: true }), 0)
      if (done.target !== null) handlers.current.onDrop(done.id, done.target)
    }
    const cancel = (ev: KeyboardEvent) => ev.key === 'Escape' && cleanup.current()

    cleanup.current = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('keydown', cancel)
      document.body.classList.remove('dragging-tag')
      current = null
      setDrag(null)
      cleanup.current = () => {}
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('keydown', cancel)
  }

  return { drag, start }
}
