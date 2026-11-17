import { useEffect, useRef, useState } from 'react'

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
