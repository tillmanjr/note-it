import { Capacitor, registerPlugin } from '@capacitor/core'
import { Directory, Filesystem } from '@capacitor/filesystem'
import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite'
import { fromBase64, toBase64, type BlobStore, type NativeKeys, type SqlDriver } from '@tdjr/core'

// Tablet storage (docs/mobile.md): SQLite through @capacitor-community/sqlite, attachment files in the app's
// private data directory, and the Keystore device key from the app's own plugin (apps/mobile).

export async function capacitorDriver(): Promise<SqlDriver> {
  const sqlite = new SQLiteConnection(CapacitorSQLite)
  const db = (await sqlite.isConnection('notes', false)).result
    ? await sqlite.retrieveConnection('notes', false)
    : await sqlite.createConnection('notes', false, 'no-encryption', 1, false)
  await db.open()
  await db.execute('PRAGMA foreign_keys = ON', false)
  return {
    async execute(sql, params = []) {
      await db.run(sql, params as unknown[], false)
    },
    async select<T>(sql: string, params: unknown[] = []) {
      return ((await db.query(sql, params as unknown[])).values ?? []) as T[]
    },
  }
}

export async function capacitorBlobs(): Promise<BlobStore> {
  await Filesystem.mkdir({ path: 'blobs', directory: Directory.Data, recursive: true }).catch(() => {})
  const { uri } = await Filesystem.getUri({ path: 'blobs', directory: Directory.Data })
  const path = (hash: string) => `blobs/${hash}`
  const has = (hash: string) =>
    Filesystem.stat({ path: path(hash), directory: Directory.Data }).then(
      () => true,
      () => false,
    )
  return {
    has,
    async put(hash, bytes) {
      await Filesystem.writeFile({ path: path(hash), directory: Directory.Data, data: toBase64(bytes) })
    },
    async read(hash) {
      if (!(await has(hash))) return null
      const { data } = await Filesystem.readFile({ path: path(hash), directory: Directory.Data })
      return typeof data === 'string' ? fromBase64(data) : new Uint8Array(await data.arrayBuffer())
    },
    url: (hash) => Capacitor.convertFileSrc(`${uri}/${hash}`),
  }
}

/** The app's Keystore plugin (apps/mobile/android/.../DeviceKeyPlugin.kt). */
const DeviceKey = registerPlugin<{
  createKey(options: { alias: string }): Promise<{ x: string; y: string }>
  sign(options: { alias: string; data: string; reason: string }): Promise<{ signature: string }>
}>('DeviceKey')

export const deviceKeys: NativeKeys = {
  createKey: (alias) => DeviceKey.createKey({ alias }),
  sign: async (alias, data, reason) => (await DeviceKey.sign({ alias, data, reason })).signature,
}

export interface Share {
  text: string
  subject?: string | null
}

const ShareTarget = registerPlugin<{
  addListener(event: 'shared', handler: (share: Share) => void): Promise<{ remove: () => Promise<void> }>
}>('ShareTarget')

/** Text and links shared to Notes from other apps (including the one that launched the app). */
export function onShared(handler: (share: Share) => void): () => void {
  const listener = ShareTarget.addListener('shared', handler)
  return () => void listener.then((l) => l.remove())
}
