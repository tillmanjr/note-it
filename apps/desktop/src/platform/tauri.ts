import Database from '@tauri-apps/plugin-sql'
import { exists, mkdir, readFile, writeFile, BaseDirectory } from '@tauri-apps/plugin-fs'
import { appDataDir, join } from '@tauri-apps/api/path'
import { convertFileSrc } from '@tauri-apps/api/core'
import type { BlobStore, SqlDriver } from '@tdjr/core'

// Desktop storage: SQLite via tauri-plugin-sql, attachment files under <appdata>/blobs.

export async function tauriDriver(): Promise<SqlDriver> {
  const db = await Database.load('sqlite:notes.db')
  await db.execute('PRAGMA foreign_keys = ON')
  return {
    async execute(sql, params = []) {
      await db.execute(sql, params)
    },
    async select<T>(sql: string, params: unknown[] = []) {
      return db.select<T[]>(sql, params)
    },
  }
}

export async function tauriBlobs(): Promise<BlobStore> {
  const base = await appDataDir()
  const blobDir = await join(base, 'blobs')
  if (!(await exists('blobs', { baseDir: BaseDirectory.AppData }))) {
    await mkdir('blobs', { baseDir: BaseDirectory.AppData, recursive: true })
  }
  // Windows paths use backslashes; the asset protocol accepts either once encoded.
  const sep = blobDir.includes('\\') ? '\\' : '/'
  return {
    has: (hash) => exists(`blobs/${hash}`, { baseDir: BaseDirectory.AppData }),
    put: (hash, bytes) => writeFile(`blobs/${hash}`, bytes, { baseDir: BaseDirectory.AppData }),
    read: async (hash) =>
      (await exists(`blobs/${hash}`, { baseDir: BaseDirectory.AppData }))
        ? readFile(`blobs/${hash}`, { baseDir: BaseDirectory.AppData })
        : null,
    url: (hash) => convertFileSrc(`${blobDir}${sep}${hash}`),
  }
}
