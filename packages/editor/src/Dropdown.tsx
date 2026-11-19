import { useEffect, useRef, useState, type ReactNode } from 'react'

/**
 * A narrow toolbar button that opens a small panel below it. Escape, a click outside, or `close()`
 * from the panel closes it. The button doesn't take focus, so the editor keeps its selection.
 */
export function Dropdown({
  label,
  title,
  active = false,
  className = '',
  children,
}: {
  label: ReactNode
  title: string
  active?: boolean
  className?: string
  children: (close: () => void) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false)
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  return (
    <div className={`dropdown ${className}`} ref={root}>
      <button
        className={`dropdown-button${open || active ? ' active' : ''}`}
        title={title}
        aria-haspopup="true"
        aria-expanded={open}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((o) => !o)}
      >
        {label}
        <span className="caret">▾</span>
      </button>
      {open && <div className="dropdown-panel">{children(() => setOpen(false))}</div>}
    </div>
  )
}

/** A row in a dropdown panel. */
export function DropdownItem({
  active = false,
  onSelect,
  children,
  title,
}: {
  active?: boolean
  onSelect: () => void
  children: ReactNode
  title?: string
}) {
  return (
    <button
      className={`dropdown-item${active ? ' active' : ''}`}
      title={title}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onSelect}
    >
      {children}
    </button>
  )
}
