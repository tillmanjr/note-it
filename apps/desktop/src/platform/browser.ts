import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import type { BlobStore, SqlDriver } from '@tdjr/core'

// Browser fallback for UI development outside Tauri (`npm run dev`, then open the page).
// SQLite runs in WASM, persisted to localStorage (small: dev data only). Attachments live in memory.

export async function browserDriver(): Promise<SqlDriver> {
  const sqlite3 = await sqlite3InitModule()
  const db = new sqlite3.oo1.JsStorageDb('local')
  return {
    async execute(sql, params = []) {
      db.exec({ sql, bind: params as never })
    },
    async select<T>(sql: string, params: unknown[] = []) {
      return db.exec({ sql, bind: params as never, rowMode: 'object', returnValue: 'resultRows' }) as T[]
    },
  }
}

export function browserBlobs(): BlobStore {
  const urls = new Map<string, string>()
  const files = new Map<string, Uint8Array>()
  return {
    async has(hash) {
      return urls.has(hash)
    },
    async put(hash, bytes) {
      files.set(hash, bytes)
      urls.set(hash, URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>])))
    },
    async read(hash) {
      return files.get(hash) ?? null
    },
    url: (hash) => urls.get(hash) ?? '',
  }
}
