import { isTauri } from '@tauri-apps/api/core'
import { NoteStore } from '@tdjr/core'

export const runningInTauri = isTauri()

let opening: Promise<NoteStore> | null = null

/** Opens the local note store for this platform and applies migrations (once per app session). */
export function openStore(): Promise<NoteStore> {
  opening ??= open()
  return opening
}

async function open(): Promise<NoteStore> {
  let store: NoteStore
  if (runningInTauri) {
    const { tauriDriver, tauriBlobs } = await import('./tauri')
    store = new NoteStore(await tauriDriver(), await tauriBlobs())
  } else {
    const { browserDriver, browserBlobs } = await import('./browser')
    store = new NoteStore(await browserDriver(), browserBlobs())
  }
  await store.migrate()
  if ((await store.listNotebooks()).length === 0) await store.createNotebook('Notes')
  return store
}
