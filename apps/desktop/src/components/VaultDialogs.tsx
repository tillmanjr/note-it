import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { MIN_PASSPHRASE_LENGTH, type NoteStore } from '@tdjr/core'
import { VaultController, type PassphraseRequest } from '../vault'
import { Dialog } from './SyncDialogs'

// The vault's UI (docs/vault.md): one controller per workspace, the passphrase dialogs, and a hook for the
// editor and the ⚙ menu.

const VaultContext = createContext<VaultController | null>(null)

export function VaultProvider({ store, children }: { store: NoteStore; children: ReactNode }) {
  const [vault, setVault] = useState<VaultController | null>(null)
  const [request, setRequest] = useState<PassphraseRequest | null>(null)
  useEffect(() => {
    const v = new VaultController(store)
    v.ask = setRequest
    setVault(v)
    return () => v.dispose()
  }, [store])
  return (
    <VaultContext.Provider value={vault}>
      {children}
      {request && <PassphraseDialog key={request.mode} request={request} />}
    </VaultContext.Provider>
  )
}

/** The vault, and its open/exists state (re-renders when it opens or locks). */
export function useVault(): { vault: VaultController | null; open: boolean; exists: boolean } {
  const vault = useContext(VaultContext)
  const state = useSyncExternalStore(
    (onChange) => vault?.subscribe(onChange) ?? (() => {}),
    () => (vault ? `${vault.isOpen}:${vault.exists}` : 'none'),
  )
  return { vault, open: state.startsWith('true'), exists: state.endsWith(':true') }
}

function PassphraseField({ id, label, value, onChange, autoFocus }: { id: string; label: string; value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  return (
    <label>
      {label}
      <input
        id={id}
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoFocus={autoFocus}
      />
    </label>
  )
}

function PassphraseDialog({ request }: { request: PassphraseRequest }) {
  const setup = request.mode === 'setup'
  const [passphrase, setPassphrase] = useState('')
  const [again, setAgain] = useState('')
  const [understood, setUnderstood] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const problem = !setup
    ? passphrase
      ? null
      : ''
    : passphrase.length < MIN_PASSPHRASE_LENGTH
      ? `Use at least ${MIN_PASSPHRASE_LENGTH} characters.`
      : passphrase !== again
        ? 'The two entries don’t match.'
        : !understood
          ? ''
          : null
  const submit = async () => {
    if (problem !== null || busy) return
    setBusy(true)
    setError(null)
    const err = await request.submit(passphrase)
    if (err) {
      setError(err)
      setBusy(false)
      setPassphrase('')
    }
  }
  return (
    <Dialog
      title={setup ? 'Set up the vault' : 'Unlock the vault'}
      onClose={request.cancel}
      footer={
        <>
          {(error || (setup && passphrase && problem)) && <span className="error">{error ?? problem}</span>}
          <span className="spacer" />
          <button onClick={request.cancel}>Cancel</button>
          <button className="primary" disabled={problem !== null || busy} onClick={() => void submit()}>
            {busy ? (setup ? 'Setting up…' : 'Unlocking…') : setup ? 'Set up' : 'Unlock'}
          </button>
        </>
      }
    >
      <p className="hint">
        {setup
          ? 'Encrypted sections are locked with a passphrase that only you know. It never leaves this device, and the server only ever stores scrambled text.'
          : 'Enter the vault passphrase to show encrypted sections. They lock again after 3 minutes without activity, or when the window is hidden.'}
      </p>
      <form
        className="form-fields"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <PassphraseField id="vault-passphrase" label="Passphrase" value={passphrase} onChange={setPassphrase} autoFocus />
        {setup && <PassphraseField id="vault-passphrase-again" label="Passphrase again" value={again} onChange={setAgain} />}
        {setup && (
          <label className="checkbox">
            <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
            <span>
              I understand that <strong>a forgotten passphrase can’t be recovered</strong>, and neither can anything
              encrypted with it. I’ll keep it in my password manager.
            </span>
          </label>
        )}
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}

export function ChangePassphraseDialog({ onClose }: { onClose: () => void }) {
  const { vault } = useVault()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const problem = !current
    ? ''
    : next.length < MIN_PASSPHRASE_LENGTH
      ? `Use at least ${MIN_PASSPHRASE_LENGTH} characters for the new passphrase.`
      : next !== again
        ? 'The two new entries don’t match.'
        : null
  const submit = async () => {
    if (!vault || problem !== null || busy) return
    setBusy(true)
    setError(null)
    try {
      await vault.changePassphrase(current, next)
      setDone(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setCurrent('')
    }
    setBusy(false)
  }
  return (
    <Dialog
      title="Change vault passphrase"
      onClose={onClose}
      footer={
        <>
          {(error || (next && problem)) && !done && <span className="error">{error ?? problem}</span>}
          <span className="spacer" />
          {done ? (
            <button className="primary" onClick={onClose}>
              Done
            </button>
          ) : (
            <>
              <button onClick={onClose}>Cancel</button>
              <button className="primary" disabled={problem !== null || busy} onClick={() => void submit()}>
                {busy ? 'Changing…' : 'Change passphrase'}
              </button>
            </>
          )}
        </>
      }
    >
      {done ? (
        <p className="hint">The passphrase is changed on this device and syncs to your other devices. Use the new one from now on.</p>
      ) : (
        <form
          className="form-fields"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <PassphraseField id="vault-current" label="Current passphrase" value={current} onChange={setCurrent} autoFocus />
          <PassphraseField id="vault-new" label="New passphrase" value={next} onChange={setNext} />
          <PassphraseField id="vault-new-again" label="New passphrase again" value={again} onChange={setAgain} />
          <button type="submit" hidden />
        </form>
      )}
    </Dialog>
  )
}
