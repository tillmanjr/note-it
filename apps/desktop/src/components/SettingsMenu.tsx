import { useEffect, useRef, useState } from 'react'
import type { SyncStatus } from '@tdjr/core'
import type { ThemePref } from '../theme'
import { formatWhen } from './NoteList'

const THEMES: { pref: ThemePref; icon: string; label: string }[] = [
  { pref: 'system', icon: '◐', label: 'System' },
  { pref: 'light', icon: '☀', label: 'Light' },
  { pref: 'dark', icon: '☾', label: 'Dark' },
]

export interface SyncMenu {
  /** null while this device isn't connected to a server. */
  status: SyncStatus | null
  onConnect: () => void
  onSyncNow: () => void
  onAddDevice: () => void
  onDevices: () => void
}

/** One line for the menu: how sync is doing right now. */
function syncLabel(s: SyncStatus): string {
  switch (s.state) {
    case 'syncing':
      return 'Syncing…'
    case 'offline':
      return 'Offline · changes kept here'
    case 'error':
      return 'Sync stopped'
    case 'idle':
      return s.lastSyncAt ? `Synced · ${formatWhen(s.lastSyncAt)}` : 'Waiting to sync'
  }
}

/** The ⚙ button and its dropdown: app-level settings and actions. Escape or a click outside closes it. */
export function SettingsMenu({
  theme,
  onTheme,
  onImport,
  sync,
}: {
  theme: ThemePref
  onTheme: (pref: ThemePref) => void
  onImport: () => void
  sync: SyncMenu
}) {
  const [open, setOpen] = useState(false)
  const close = (action: () => void) => () => {
    setOpen(false)
    action()
  }
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
        {sync.status && sync.status.state !== 'idle' && sync.status.state !== 'syncing' && (
          <span className={`sync-dot ${sync.status.state}`} aria-label={syncLabel(sync.status)} />
        )}
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
          <div className="menu-separator" />
          <div className="menu-label">Sync</div>
          {sync.status ? (
            <>
              <button
                className={`menu-item sync-state ${sync.status.state}`}
                role="menuitem"
                title={sync.status.error ?? 'Sync now'}
                onClick={sync.onSyncNow}
              >
                <span className="menu-icon">⇅</span> {syncLabel(sync.status)}
                <span className="menu-hint">Sync now</span>
              </button>
              {sync.status.error && <div className="menu-note">{sync.status.error}</div>}
              <button className="menu-item" role="menuitem" onClick={close(sync.onAddDevice)}>
                <span className="menu-icon">＋</span> Add a device…
              </button>
              <button className="menu-item" role="menuitem" onClick={close(sync.onDevices)}>
                <span className="menu-icon">▤</span> Devices…
              </button>
            </>
          ) : (
            <button className="menu-item" role="menuitem" onClick={close(sync.onConnect)}>
              <span className="menu-icon">⇅</span> Connect to server…
            </button>
          )}
        </div>
      )}
    </div>
  )
}
