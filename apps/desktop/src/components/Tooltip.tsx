import { useEffect, useRef, useState, type ReactNode } from 'react'

/** Hover time before a tooltip appears. */
const DELAY_MS = 500

/**
 * A tooltip shown above its children after hovering for a moment. Leaving, clicking or typing hides it.
 * `align="end"` lines it up with the right edge, for controls near the right side of the window.
 */
export function Tooltip({
  tip,
  align = 'start',
  disabled = false,
  className = '',
  children,
}: {
  tip: ReactNode
  align?: 'start' | 'end'
  /** Keeps the tip hidden, e.g. while a menu covers the same spot. */
  disabled?: boolean
  className?: string
  children: ReactNode
}) {
  const [shown, setShown] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const hide = () => {
    clearTimeout(timer.current)
    setShown(false)
  }
  useEffect(() => () => clearTimeout(timer.current), [])

  return (
    <span
      className={`has-tooltip ${className}`}
      onMouseEnter={() => {
        clearTimeout(timer.current)
        timer.current = setTimeout(() => setShown(true), DELAY_MS)
      }}
      onMouseLeave={hide}
      onMouseDown={hide}
      onKeyDownCapture={hide}
    >
      {children}
      {shown && !disabled && (
        <span className={`tooltip ${align}`} role="tooltip">
          {tip}
        </span>
      )}
    </span>
  )
}
