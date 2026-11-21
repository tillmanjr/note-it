import {
  changePassphrase,
  createVault,
  currentKeyId,
  decryptSection,
  encryptSection,
  unlockVault,
  type NoteStore,
  type SectionCipher,
  type VaultKeyRecord,
  type VaultKeys,
} from '@tdjr/core'
import type { SectionAttrs, VaultBridge } from '@tdjr/editor'
import type { JSONContent } from '@tiptap/react'

// The vault while the app runs (docs/vault.md). The open keys live only in this object's memory and are
// dropped on lock: after 3 minutes without activity in an open section, when the window is hidden, or on
// request. The passphrase itself is never kept; it's used once to unwrap the keys.

export const AUTO_LOCK_MS = 3 * 60_000

/** What the passphrase dialog is for. `submit` returns an error to show, or null when done. */
export interface PassphraseRequest {
  mode: 'setup' | 'unlock'
  submit: (passphrase: string) => Promise<string | null>
  cancel: () => void
}

export class VaultController {
  private keys: VaultKeys | null = null
  private records: VaultKeyRecord[] = []
  private readonly listeners = new Set<() => void>()
  private readonly flushers = new Set<() => Promise<void>>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private opening: Promise<boolean> | null = null
  /** Set by the UI: shows the passphrase dialog. */
  ask: (request: PassphraseRequest | null) => void = () => {}

  private readonly cleanup: (() => void)[] = []

  private readonly store: NoteStore

  constructor(store: NoteStore) {
    this.store = store
    void this.reload()
    // Keys added or rewrapped on another device.
    this.cleanup.push(
      store.onChange((e) => {
        if (e.type === 'remote' && e.metadata) void this.reload()
      }),
    )
    const onVisibility = () => document.visibilityState === 'hidden' && this.lock()
    document.addEventListener('visibilitychange', onVisibility)
    this.cleanup.push(() => document.removeEventListener('visibilitychange', onVisibility))
  }

  dispose() {
    this.lock()
    for (const c of this.cleanup) c()
  }

  get isOpen(): boolean {
    return this.keys !== null
  }

  get exists(): boolean {
    return this.records.length > 0
  }

  private async reload() {
    this.records = await this.store.listVaultKeys()
    this.emit()
  }

  private emit() {
    for (const l of this.listeners) l()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  touch() {
    if (!this.keys) return
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.lock(), AUTO_LOCK_MS)
  }

  /** Asks for the passphrase (or to set the vault up) unless it's open. */
  open(): Promise<boolean> {
    if (this.keys) return Promise.resolve(true)
    this.opening ??= this.askToOpen().finally(() => {
      this.opening = null
    })
    return this.opening
  }

  private async askToOpen(): Promise<boolean> {
    await this.reload()
    return new Promise<boolean>((resolve) => {
      const done = (ok: boolean) => {
        this.ask(null)
        resolve(ok)
      }
      this.ask({
        mode: this.exists ? 'unlock' : 'setup',
        cancel: () => done(false),
        submit: async (passphrase) => {
          try {
            if (this.exists) {
              this.keys = await unlockVault(passphrase, this.records)
            } else {
              const { record, keys } = await createVault(passphrase)
              await this.store.saveVaultKey(record)
              this.records = [record]
              this.keys = keys
            }
          } catch (e) {
            return e instanceof Error ? e.message : String(e)
          }
          this.touch()
          this.emit()
          done(true)
          return null
        },
      })
    })
  }

  lock() {
    if (!this.keys) return
    clearTimeout(this.timer)
    // Save open sections while the keys are still here, then drop them.
    void Promise.allSettled([...this.flushers].map((f) => f())).then(() => {
      this.keys = null
      this.emit()
    })
  }

  async changePassphrase(oldPassphrase: string, newPassphrase: string): Promise<void> {
    await this.reload()
    for (const record of await changePassphrase(oldPassphrase, newPassphrase, this.records)) {
      await this.store.saveVaultKey(record)
    }
    await this.reload()
  }

  /** The bridge the editor's vault sections use. */
  readonly bridge: VaultBridge = {
    isOpen: () => this.isOpen,
    open: () => this.open(),
    lock: () => this.lock(),
    touch: () => this.touch(),
    subscribe: (listener) => this.subscribe(listener),
    beforeLock: (flush) => {
      this.flushers.add(flush)
      return () => this.flushers.delete(flush)
    },
    encrypt: async (content: JSONContent[], kid?: string): Promise<SectionAttrs> => {
      const keys = this.keys
      const id = kid && keys?.has(kid) ? kid : keys && currentKeyId(this.records, keys)
      if (!keys || !id) throw new Error('The vault is locked.')
      return encryptSection(keys, id, content)
    },
    decrypt: async (attrs: SectionAttrs): Promise<JSONContent[]> => {
      if (!this.keys) throw new Error('The vault is locked.')
      return (await decryptSection(this.keys, attrs as SectionCipher)) as JSONContent[]
    },
  }
}
