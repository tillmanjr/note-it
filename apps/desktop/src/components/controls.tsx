import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/** Text that turns into an input for editing; Enter/blur commits, Escape cancels. */
export function InlineEdit({
  value,
  editing,
  onCommit,
  onCancel,
  placeholder,
  editValue = value,
}: {
  value: string
  editing: boolean
  onCommit: (v: string) => void
  onCancel: () => void
  placeholder?: string
  /** What the box starts with, when it differs from what's shown (a tag's full path). Only its last "/" level is selected. */
  editValue?: string
}) {
  const [draft, setDraft] = useState(editValue)
  const ref = useRef<HTMLInputElement>(null)
  // A fresh draft each time editing starts, set during render so the box never shows a stale one.
  const [wasEditing, setWasEditing] = useState(editing)
  if (editing !== wasEditing) {
    setWasEditing(editing)
    if (editing) setDraft(editValue)
  }
  // Focus as soon as the box exists (a layout effect, not the next frame, so the first keystrokes land in it).
  useLayoutEffect(() => {
    if (!editing) return
    const from = editValue === value ? 0 : editValue.lastIndexOf('/') + 1
    ref.current?.focus()
    ref.current?.setSelectionRange(from, editValue.length)
  }, [editing])
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
        if (e.key === 'Enter') {
          // Consumed here, so it can't also press a button in a dialog the commit opens (the tag merge prompt).
          e.preventDefault()
          onCommit(draft)
        }
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
  ariaLabel,
  onConfirm,
  className = '',
}: {
  label: string
  confirmLabel: string
  /** Native tooltip; omit when the button is wrapped in a Tooltip. */
  title?: string
  /** Accessible name when there's no title. */
  ariaLabel?: string
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
      aria-label={ariaLabel}
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
