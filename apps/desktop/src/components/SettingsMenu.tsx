import { useEffect, useRef, useState } from 'react'
import type { SyncStatus } from '@tdjr/core'
import type { Access } from '../sync'
import type { ThemePref } from '../theme'
import { ChangePassphraseDialog, useVault } from './VaultDialogs'
import { formatWhen } from './NoteList'

const THEMES: { pref: ThemePref; icon: string; label: string }[] = [
  { pref: 'system', icon: '◐', label: 'System' },
  { pref: 'light', icon: '☀', label: 'Light' },
  { pref: 'dark', icon: '☾', label: 'Dark' },
]

export interface SyncMenu {
  access: Access
  /** Set while connected. */
  status: SyncStatus | null
  onRequest: () => void
  /** Shows the match code while waiting for approval. */
  onWaiting: () => void
  onSignIn: () => void
  onSyncNow: () => void
  onDisconnect: () => void
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
    case 'signed-out':
      return 'Signed out'
    case 'idle':
      return s.lastSyncAt ? `Synced · ${formatWhen(s.lastSyncAt)}` : 'Waiting to sync'
  }
}

/** Short form for the app bar. */
function syncShort(s: SyncStatus): string {
  switch (s.state) {
    case 'syncing':
      return 'Syncing…'
    case 'offline':
      return 'Offline'
    case 'error':
      return 'Sync stopped'
    case 'signed-out':
      return 'Signed out'
    case 'idle':
      return s.lastSyncAt ? `Synced ${formatWhen(s.lastSyncAt)}` : 'Waiting…'
  }
}

/** Always-visible sync state beside the ⚙ button. A click does the obvious next thing. */
export function SyncIndicator({ sync }: { sync: SyncMenu }) {
  const { access } = sync
  const button = (cls: string, icon: string, text: string, title: string, onClick: () => void) => (
    <button className={`sync-indicator ${cls}`} title={title} onClick={onClick}>
      <span className="sync-icon">{icon}</span> {text}
    </button>
  )
  switch (access.phase) {
    case 'none':
      return button('off', '⇅', 'Not syncing', 'This device isn’t syncing. Click to request access to a server.', sync.onRequest)
    case 'refused':
      return button('error', '!', 'Not syncing', `${access.message} Click to request access.`, sync.onRequest)
    case 'waiting':
      return button('syncing', '⌛', 'Waiting for approval', `Match code ${access.matchCode}. Click for details.`, sync.onWaiting)
    case 'signing-in':
      return button('syncing', '⇅', 'Signing in…', 'Confirm with Windows Hello.', () => {})
    case 'signed-out':
      return button('error', '!', 'Signed out', `${access.error ?? 'Signed out.'} Click to sign in.`, sync.onSignIn)
    case 'connected': {
      const s = sync.status
      if (!s) return null
      return button(
        s.state,
        s.state === 'idle' && s.lastSyncAt ? '✓' : s.state === 'offline' || s.state === 'error' ? '!' : '⇅',
        syncShort(s),
        `${s.error ?? syncLabel(s)}. Click to sync now.`,
        sync.onSyncNow,
      )
    }
  }
}

/** The Sync section of the ⚙ menu. */
function SyncItems({ sync, close }: { sync: SyncMenu; close: (action: () => void) => () => void }) {
  const { access, status } = sync
  const item = (icon: string, label: string, onClick: () => void, hint?: string) => (
    <button className="menu-item" role="menuitem" onClick={close(onClick)}>
      <span className="menu-icon">{icon}</span> {label}
      {hint && <span className="menu-hint">{hint}</span>}
    </button>
  )
  const disconnect = item('⏏', 'Disconnect this device…', sync.onDisconnect)
  switch (access.phase) {
    case 'none':
      return item('⇅', 'Request access…', sync.onRequest)
    case 'refused':
      return (
        <>
          <div className="menu-note">{access.message}</div>
          {item('⇅', 'Request access…', sync.onRequest)}
        </>
      )
    case 'waiting':
      return (
        <>
          {item('⌛', 'Waiting for approval', sync.onWaiting, access.matchCode)}
          {disconnect}
        </>
      )
    case 'signing-in':
      return <div className="menu-note">Signing in… confirm with Windows Hello.</div>
    case 'signed-out':
      return (
        <>
          {access.error && <div className="menu-note">{access.error}</div>}
          {item('⇅', 'Sign in', sync.onSignIn, 'Windows Hello')}
          {disconnect}
        </>
      )
    case 'connected':
      return (
        <>
          {status && (
            <button
              className={`menu-item sync-state ${status.state}`}
              role="menuitem"
              title={status.error ?? 'Sync now'}
              onClick={sync.onSyncNow}
            >
              <span className="menu-icon">⇅</span> {syncLabel(status)}
              <span className="menu-hint">Sync now</span>
            </button>
          )}
          {status?.error && <div className="menu-note">{status.error}</div>}
          {disconnect}
        </>
      )
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
  const [changing, setChanging] = useState(false)
  const vault = useVault()
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
          <SyncItems sync={sync} close={close} />
          {vault.exists && (
            <>
              <div className="menu-separator" />
              <div className="menu-label">Vault</div>
              {vault.open && (
                <button className="menu-item" role="menuitem" onClick={close(() => vault.vault?.lock())}>
                  <span className="menu-icon">🔒</span> Lock vault
                  <span className="menu-hint">hides encrypted sections</span>
                </button>
              )}
              <button className="menu-item" role="menuitem" onClick={close(() => setChanging(true))}>
                <span className="menu-icon">🔑</span> Change vault passphrase…
              </button>
            </>
          )}
        </div>
      )}
      {changing && <ChangePassphraseDialog onClose={() => setChanging(false)} />}
    </div>
  )
}
