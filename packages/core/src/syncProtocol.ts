// Wire format shared by the sync server (apps/server) and clients.
//
// Metadata syncs as per-field last-writer-wins records: each change names one field of one record and carries
// its HLC timestamp; the newer timestamp wins on the server and on every client. Note bodies sync as Yjs
// updates, which merge without conflicts. The server keeps one global change sequence; clients pull everything
// after the cursor they last saw (excluding their own changes).

export type RecordKind = 'notebook' | 'tag' | 'note' | 'attachment'

/** The synced fields of each record kind. Notes also carry `tags` (tag ids) and `purged` (deleted forever). */
export const SYNC_FIELDS: Record<RecordKind, readonly string[]> = {
  notebook: ['name', 'sort', 'created_at', 'updated_at', 'deleted_at'],
  tag: ['parent_id', 'name', 'created_at', 'updated_at', 'deleted_at'],
  note: ['notebook_id', 'title', 'created_at', 'updated_at', 'deleted_at', 'tags', 'purged'],
  attachment: ['mime', 'size', 'filename', 'created_at'],
}

export interface RecordChange {
  kind: RecordKind
  id: string
  field: string
  value: unknown
  /** HLC timestamp (see hlc.ts). */
  ts: string
}

export interface BodyUpdate {
  noteId: string
  /** Yjs update, base64. */
  data: string
}

export interface SyncRequest {
  /** The last cursor this device pulled up to (0 at first). */
  since: number
  records: RecordChange[]
  updates: BodyUpdate[]
}

export interface SyncResponse {
  /** Pull from here next time. */
  cursor: number
  records: RecordChange[]
  updates: BodyUpdate[]
  /** More changes after `cursor`: pull again right away. */
  hasMore: boolean
}

export interface EnrollRequest {
  code: string
  deviceName: string
}

export interface EnrollResponse {
  deviceId: string
  token: string
  /** Whether the server already holds notes (decides whether a fresh device keeps its local starter data). */
  serverHasData: boolean
}

export interface DeviceCode {
  code: string
  expiresAt: number
}

export interface DeviceInfo {
  id: string
  name: string
  createdAt: number
  lastSeenAt: number | null
  current: boolean
}

/** Sent over the event socket. The client authenticates with its first message. */
export type SocketMessage = { type: 'auth'; token: string } | { type: 'ready' } | { type: 'changed' }
