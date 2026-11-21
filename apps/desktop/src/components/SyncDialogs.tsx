import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { runningInTauri } from '../platform'

/** The local server while developing, the droplet in a release build. */
const DEFAULT_SERVER = import.meta.env.DEV ? 'http://localhost:5319' : 'https://notes.tillmanjr.com'

const errorText = (e: unknown) =>
  e instanceof TypeError ? 'Can’t reach the server. Check the address and that the server is running.' : e instanceof Error ? e.message : String(e)

export function Dialog({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer: ReactNode }) {
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

/** Asks a server for access: creates this device's passkey (Windows Hello) and sends its public half. */
export function RequestAccessDialog({
  onRequest,
  onClose,
}: {
  onRequest: (serverUrl: string, deviceName: string) => Promise<void>
  onClose: () => void
}) {
  const [server, setServer] = useState(DEFAULT_SERVER)
  const [name, setName] = useState(runningInTauri ? 'Desktop' : 'Browser')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      await onRequest(server, name)
      onClose()
    } catch (e) {
      setError(errorText(e))
      setBusy(false)
    }
  }
  return (
    <Dialog
      title="Request access"
      onClose={onClose}
      footer={
        <>
          {error && <span className="error">{error}</span>}
          <span className="spacer" />
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy || !server.trim()} onClick={() => void submit()}>
            {busy ? 'Confirm with Windows Hello…' : 'Request access'}
          </button>
        </>
      }
    >
      <p className="hint">
        This device creates its own passkey, which never leaves it. The server then has to approve the request before
        anything syncs. You’ll get a short code to match when approving it.
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
          <input id="sync-server" value={server} onChange={(e) => setServer(e.target.value)} spellCheck={false} autoFocus />
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

/** The match code to approve on the server, while this device waits. */
export function WaitingDialog({
  serverUrl,
  matchCode,
  onCheck,
  onClose,
}: {
  serverUrl: string
  matchCode: string
  onCheck: () => void
  onClose: () => void
}) {
  return (
    <Dialog
      title="Waiting for approval"
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button onClick={onCheck}>Check now</button>
          <button className="primary" onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      <p className="hint">
        Approve this device on <strong>{serverUrl}</strong>, from the server’s shell. Approve only the request showing
        this code. This device checks every 30 seconds and signs in once it’s approved; you can close this meanwhile.
      </p>
      <div className="device-code" aria-live="polite">
        {matchCode}
      </div>
      <p className="hint">
        <code>notes-admin approve {matchCode}</code>
        <br />
        Locally: <code>npm run admin -w @tdjr/server -- approve {matchCode}</code>
      </p>
    </Dialog>
  )
}

/** Forgets the server on this device. The server still trusts it until it's revoked there. */
export function DisconnectDialog({
  deviceId,
  onDisconnect,
  onClose,
}: {
  deviceId: string
  onDisconnect: () => Promise<void>
  onClose: () => void
}) {
  return (
    <Dialog
      title="Disconnect this device"
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button onClick={onClose}>Cancel</button>
          <button className="primary danger" onClick={() => void onDisconnect().then(onClose)}>
            Disconnect
          </button>
        </>
      }
    >
      <p className="hint">
        This device stops syncing and forgets the server. Its notes stay here. Its passkey still works on the server
        until you revoke it there:
      </p>
      <p className="hint">
        <code>notes-admin revoke {deviceId}</code>
      </p>
    </Dialog>
  )
}
