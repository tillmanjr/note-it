import { useCallback, useEffect, useState } from 'react'
import { SyncClient, enrollDevice, forgetSyncConfig, loadSyncConfig, type NoteStore, type SyncStatus } from '@tdjr/core'

export interface SyncControls {
  /** null while not connected to a server. */
  client: SyncClient | null
  status: SyncStatus | null
  connect: (serverUrl: string, code: string, deviceName: string) => Promise<void>
  /** Forgets the server here; notes stay on this device. */
  disconnect: () => Promise<void>
}

/** Runs sync for the app's lifetime when this device is connected to a server. */
export function useSync(store: NoteStore): SyncControls {
  const [client, setClient] = useState<SyncClient | null>(null)
  const [status, setStatus] = useState<SyncStatus | null>(null)

  useEffect(() => {
    let cancelled = false
    void loadSyncConfig(store).then((config) => {
      if (!cancelled && config) setClient(new SyncClient(store, config))
    })
    return () => {
      cancelled = true
    }
  }, [store])

  useEffect(() => {
    if (!client) {
      setStatus(null)
      return
    }
    setStatus(client.getStatus())
    const off = client.onStatus(setStatus)
    client.start()
    return () => {
      off()
      client.stop()
    }
  }, [client])

  const connect = useCallback(
    async (serverUrl: string, code: string, deviceName: string) => {
      const config = await enrollDevice(store, serverUrl, code, deviceName)
      setClient(new SyncClient(store, config))
    },
    [store],
  )

  const disconnect = useCallback(async () => {
    client?.stop()
    await forgetSyncConfig(store)
    setClient(null)
  }, [client, store])

  return { client, status, connect, disconnect }
}
