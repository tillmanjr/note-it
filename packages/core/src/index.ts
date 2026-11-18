export * from './model'
export * from './tagTree'
export { NoteStore, ftsQuery, HIT_START, HIT_END, type SearchHit, type SqlDriver, type BlobStore, type StoreEvent } from './store'
export { toBase64, fromBase64, sha256Hex } from './encoding'
export { bodyText, snippetOf, BODY_FIELD } from './bodyText'
export { Hlc } from './hlc'
export * from './syncProtocol'
export {
  SyncClient,
  SyncHttpError,
  enrollDevice,
  forgetSyncConfig,
  loadSyncConfig,
  type SyncConfig,
  type SyncState,
  type SyncStatus,
} from './syncClient'
