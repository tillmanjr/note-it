import { useEffect, useRef, useState } from 'react'
import type { ThemePref } from '../theme'

const THEMES: { pref: ThemePref; icon: string; label: string }[] = [
  { pref: 'system', icon: '◐', label: 'System' },
  { pref: 'light', icon: '☀', label: 'Light' },
  { pref: 'dark', icon: '☾', label: 'Dark' },
]

/** The ⚙ button and its dropdown: app-level settings and actions. Escape or a click outside closes it. */
export function SettingsMenu({
  theme,
  onTheme,
  onImport,
}: {
  theme: ThemePref
  onTheme: (pref: ThemePref) => void
  onImport: () => void
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="settings" ref={root}>
      <button
        className={`settings-button${open ? ' open' : ''}`}
        title="Settings"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        ⚙
      </button>
      {open && (
        <div className="settings-menu" role="menu">
          <div className="menu-label">Theme</div>
          <div className="segmented" role="group" aria-label="Theme">
            {THEMES.map((t) => (
              <button key={t.pref} className={t.pref === theme ? 'on' : ''} aria-pressed={t.pref === theme} onClick={() => onTheme(t.pref)}>
                <span className="segment-icon">{t.icon}</span> {t.label}
              </button>
            ))}
          </div>
          <div className="menu-separator" />
          <button
            className="menu-item"
            role="menuitem"
            onClick={() => {
              setOpen(false)
              onImport()
            }}
          >
            <span className="menu-icon">⤓</span> Import notebooks…
            <span className="menu-hint">Evernote .enex</span>
          </button>
        </div>
      )}
    </div>
  )
}
