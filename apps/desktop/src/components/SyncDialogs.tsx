import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { DeviceCode, DeviceInfo, SyncClient } from '@tdjr/core'
import { runningInTauri } from '../platform'
import { formatWhen } from './NoteList'

const DEFAULT_SERVER = 'http://localhost:8787'

const errorText = (e: unknown) =>
  e instanceof TypeError ? 'Can’t reach the server. Check the address and that the server is running.' : e instanceof Error ? e.message : String(e)

function Dialog({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return createPortal(
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog sync-dialog" role="dialog" aria-label={title} onMouseDown={(e) => e.stopPropagation()}>
        <header>
          <h2>{title}</h2>
          <button className="close" title="Close" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="sync-dialog-body">{children}</div>
        <footer>{footer}</footer>
      </div>
    </div>,
    document.body,
  )
}

/** Connects this device to a sync server with a one-time code. */
export function ConnectDialog({
  onConnect,
  onClose,
}: {
  onConnect: (serverUrl: string, code: string, deviceName: string) => Promise<void>
  onClose: () => void
}) {
  const [server, setServer] = useState(DEFAULT_SERVER)
  const [code, setCode] = useState('')
  const [name, setName] = useState(runningInTauri ? 'Desktop' : 'Browser')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      await onConnect(server, code, name)
      onClose()
    } catch (e) {
      setError(errorText(e))
      setBusy(false)
    }
  }
  return (
    <Dialog
      title="Connect to server"
      onClose={onClose}
      footer={
        <>
          {error && <span className="error">{error}</span>}
          <span className="spacer" />
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy || !server.trim() || !code.trim()} onClick={() => void submit()}>
            {busy ? 'Connecting…' : 'Connect'}
          </button>
        </>
      }
    >
      <p className="hint">
        Your notes sync to this server and to your other devices. For the first device, use the setup code the server
        printed when it started. For another device, open ⚙ → Add a device on a device that’s already connected.
      </p>
      <form
        className="form-fields"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <label>
          Server
          <input id="sync-server" value={server} onChange={(e) => setServer(e.target.value)} spellCheck={false} />
        </label>
        <label>
          Code
          <input
            id="sync-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="XXXX-XXXX"
            autoFocus
            spellCheck={false}
            autoComplete="off"
          />
        </label>
        <label>
          Name for this device
          <input id="sync-device-name" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}

/** Shows a short-lived code another device can use to connect. */
export function AddDeviceDialog({ client, onClose }: { client: SyncClient; onClose: () => void }) {
  const [code, setCode] = useState<DeviceCode | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    client.createDeviceCode().then(setCode, (e: unknown) => setError(errorText(e)))
  }, [client])
  return (
    <Dialog title="Add a device" onClose={onClose} footer={<><span className="spacer" /><button onClick={onClose}>Done</button></>}>
      <p className="hint">
        On the new device, open ⚙ → Connect to server, enter <strong>{client.config.serverUrl}</strong> and this code. It
        works once and expires at {code ? new Date(code.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '…'}.
      </p>
      <div className="device-code" aria-live="polite">
        {error ? <span className="error">{error}</span> : (code?.code ?? '…')}
      </div>
    </Dialog>
  )
}

/** Lists connected devices; any of them can be disconnected. */
export function DevicesDialog({
  client,
  onDisconnectThis,
  onClose,
}: {
  client: SyncClient
  onDisconnectThis: () => Promise<void>
  onClose: () => void
}) {
  const [devices, setDevices] = useState<DeviceInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const load = () => client.listDevices().then(setDevices, (e: unknown) => setError(errorText(e)))
  useEffect(() => {
    void load()
    // load only depends on the client
  }, [client])

  const disconnect = async (d: DeviceInfo) => {
    setConfirming(null)
    try {
      await client.revokeDevice(d.id)
      if (d.current) {
        await onDisconnectThis()
        onClose()
      } else {
        await load()
      }
    } catch (e) {
      setError(errorText(e))
    }
  }

  return (
    <Dialog title="Devices" onClose={onClose} footer={<>{error && <span className="error">{error}</span>}<span className="spacer" /><button onClick={onClose}>Done</button></>}>
      <p className="hint">
        These devices sync with {client.config.serverUrl}. Disconnecting one stops it syncing; its notes stay on it.
      </p>
      <ul className="device-list">
        {devices === null && !error && <li className="hint">Loading…</li>}
        {devices?.map((d) => (
          <li key={d.id}>
            <span className="device-name">
              {d.name}
              {d.current && <span className="badge">this device</span>}
            </span>
            <span className="device-seen">{d.lastSeenAt ? `Last synced ${formatWhen(d.lastSeenAt)}` : 'Never synced'}</span>
            {confirming === d.id ? (
              <button className="danger" onClick={() => void disconnect(d)}>
                Disconnect?
              </button>
            ) : (
              <button onClick={() => setConfirming(d.id)}>Disconnect</button>
            )}
          </li>
        ))}
      </ul>
    </Dialog>
  )
}
