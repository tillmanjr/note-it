import { useCallback, useEffect, useRef, useState } from 'react'
import {
  SyncClient,
  SyncHttpError,
  accessState,
  forgetSyncConfig,
  loadSyncConfig,
  requestAccess,
  signIn,
  type NoteStore,
  type SyncConfig,
  type SyncStatus,
} from '@tdjr/core'
import { passkeys } from './platform/passkeys'

// Joining and signing in (docs/passkeys.md). A device asks for access with its own passkey, waits while an admin
// approves it on the server, then signs in with Windows Hello once per launch. The session lives in memory.

/** Where this device stands with the server. */
export type Access =
  | { phase: 'none' }
  | { phase: 'waiting'; config: SyncConfig; matchCode: string }
  | { phase: 'refused'; message: string }
  | { phase: 'signing-in'; config: SyncConfig }
  | { phase: 'signed-out'; config: SyncConfig; error: string | null }
  | { phase: 'connected'; config: SyncConfig }

export interface SyncControls {
  access: Access
  /** Set while connected. */
  client: SyncClient | null
  status: SyncStatus | null
  request: (serverUrl: string, deviceName: string) => Promise<void>
  /** Checks the request or signs in again (one Windows Hello prompt once approved). */
  signIn: () => void
  /** Forgets the server here; notes stay on this device. */
  disconnect: () => Promise<void>
}

/** While waiting for approval, ask the server this often. */
const POLL_MS = 30_000

const reachError = (e: unknown) =>
  e instanceof SyncHttpError ? e.message : e instanceof TypeError ? 'Can’t reach the server. Try again when it’s back.' : String(e instanceof Error ? e.message : e)

export function useSync(store: NoteStore): SyncControls {
  const [access, setAccess] = useState<Access>({ phase: 'none' })
  const [client, setClient] = useState<SyncClient | null>(null)
  const [status, setStatus] = useState<SyncStatus | null>(null)
  /** One check or sign-in at a time, so a passkey prompt never shows twice. */
  const busy = useRef(false)

  const advance = useCallback(
    async (config: SyncConfig) => {
      if (busy.current) return
      busy.current = true
      try {
        const state = await accessState(config)
        if (state.status === 'pending') return setAccess({ phase: 'waiting', config, matchCode: 'matchCode' in state ? state.matchCode : '' })
        if (state.status !== 'approved') return setAccess({ phase: 'refused', message: 'message' in state ? state.message : 'Request access again.' })
        setAccess({ phase: 'signing-in', config })
        const session = await signIn(store, config, passkeys)
        setClient(new SyncClient(store, config, session))
        setAccess({ phase: 'connected', config })
      } catch (e) {
        if (e instanceof SyncHttpError && e.refused && e.refused !== 'approved') {
          setAccess({ phase: 'refused', message: e.message })
        } else {
          setAccess({ phase: 'signed-out', config, error: reachError(e) })
        }
      } finally {
        busy.current = false
      }
    },
    [store],
  )

  // On launch: pick up where this device left off.
  useEffect(() => {
    let cancelled = false
    void loadSyncConfig(store).then((config) => {
      if (!cancelled && config) void advance(config)
    })
    return () => {
      cancelled = true
    }
  }, [store, advance])

  // While waiting for approval, check now and then.
  useEffect(() => {
    if (access.phase !== 'waiting') return
    const timer = setInterval(() => void advance(access.config), POLL_MS)
    return () => clearInterval(timer)
  }, [access, advance])

  useEffect(() => {
    if (!client) {
      setStatus(null)
      return
    }
    setStatus(client.getStatus())
    const off = client.onStatus((s) => {
      setStatus(s)
      if (s.state === 'signed-out') {
        setClient(null)
        setAccess({ phase: 'signed-out', config: client.config, error: s.error })
      }
    })
    client.start()
    return () => {
      off()
      client.stop()
    }
  }, [client])

  const request = useCallback(
    async (serverUrl: string, deviceName: string) => {
      client?.stop()
      setClient(null)
      const { config, state } = await requestAccess(store, serverUrl, deviceName, passkeys)
      setAccess({ phase: 'waiting', config, matchCode: state.matchCode })
    },
    [client, store],
  )

  const retry = useCallback(() => {
    if ('config' in access) void advance(access.config)
  }, [access, advance])

  const disconnect = useCallback(async () => {
    client?.stop()
    setClient(null)
    await forgetSyncConfig(store)
    setAccess({ phase: 'none' })
  }, [client, store])

  return { access, client, status, request, signIn: retry, disconnect }
}
