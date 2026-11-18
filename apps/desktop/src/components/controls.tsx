import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTheme, type ThemePref } from '../theme'

const THEMES: Record<ThemePref, { icon: string; label: string; next: ThemePref }> = {
  system: { icon: '◐', label: 'System', next: 'light' },
  light: { icon: '☀', label: 'Light', next: 'dark' },
  dark: { icon: '☾', label: 'Dark', next: 'system' },
}

/** Cycles the app theme: System → Light → Dark. */
export function ThemeToggle() {
  const [pref, setPref] = useTheme()
  const { icon, label, next } = THEMES[pref]
  return (
    <button className="theme-toggle" title={`Theme: ${label} (click for ${THEMES[next].label})`} onClick={() => setPref(next)}>
      {icon}
    </button>
  )
}

/** Text that turns into an input for editing; Enter/blur commits, Escape cancels. */
export function InlineEdit({
  value,
  editing,
  onCommit,
  onCancel,
  placeholder,
}: {
  value: string
  editing: boolean
  onCommit: (v: string) => void
  onCancel: () => void
  placeholder?: string
}) {
  const [draft, setDraft] = useState(value)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (editing) {
      setDraft(value)
      requestAnimationFrame(() => ref.current?.select())
    }
  }, [editing, value])
  if (!editing) return <span className="label">{value}</span>
  return (
    <input
      ref={ref}
      className="inline-edit"
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onCommit(draft)
        else if (e.key === 'Escape') onCancel()
      }}
      onBlur={() => onCommit(draft)}
    />
  )
}

/** A button that needs a second click within a few seconds, instead of a modal confirm. */
export function ConfirmButton({
  label,
  confirmLabel,
  title,
  onConfirm,
  className = '',
}: {
  label: string
  confirmLabel: string
  title: string
  onConfirm: () => void
  className?: string
}) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 3000)
    return () => clearTimeout(t)
  }, [armed])
  return (
    <button
      className={`${className} ${armed ? 'danger' : ''}`}
      title={title}
      onClick={(e) => {
        e.stopPropagation()
        if (armed) {
          setArmed(false)
          onConfirm()
        } else setArmed(true)
      }}
    >
      {armed ? confirmLabel : label}
    </button>
  )
}

/** A modal confirm for destructive actions that can't be undone. Escape or clicking outside cancels. */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  title: string
  message: string
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
}) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    cancelRef.current?.focus()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])
  // Portaled to <body> so the dialog doesn't inherit the styles of whatever pane opened it.
  return createPortal(
    <div className="overlay" onMouseDown={onCancel}>
      <div className="dialog confirm-dialog" role="alertdialog" aria-label={title} onMouseDown={(e) => e.stopPropagation()}>
        <header>
          <h2>{title}</h2>
        </header>
        <p className="hint">{message}</p>
        <footer>
          <span className="spacer" />
          <button ref={cancelRef} onClick={onCancel}>
            Cancel
          </button>
          <button className="primary danger" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  )
}
