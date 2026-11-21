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

// ---------- Joining and signing in (passkeys) ----------
// Byte fields are base64url strings. A device registers its own passkey with a request; an admin approves
// it on the server; the device then signs in with that passkey on each launch to get a short-lived token.

export interface AccessRequest {
  deviceName: string
}

/** What a device's authenticator needs to create its passkey. */
export interface PasskeyCreateOptions {
  rpId: string
  rpName: string
  /** The WebAuthn user handle (this device's request id, as bytes). */
  userId: string
  userName: string
  challenge: string
  timeoutMs: number
}

export interface AccessRequestStarted {
  requestId: string
  options: PasskeyCreateOptions
}

/** A newly created passkey, as the authenticator returned it. */
export interface PasskeyCreated {
  credentialId: string
  clientDataJSON: string
  attestationObject: string
  transports?: string[]
}

export type AccessStatus = 'pending' | 'approved' | 'denied' | 'revoked' | 'expired'

export interface AccessRequestState {
  status: AccessStatus
  /** Shown on the device and by `notes-admin pending`; approve only the request whose code matches. */
  matchCode: string
}

export interface SignInRequest {
  deviceId: string
}

export interface PasskeyGetOptions {
  rpId: string
  challenge: string
  allowCredentials: string[]
  timeoutMs: number
}

export interface PasskeyAssertion {
  credentialId: string
  clientDataJSON: string
  authenticatorData: string
  signature: string
  userHandle?: string
}

export interface SessionRequest {
  deviceId: string
  assertion: PasskeyAssertion
}

export interface Session {
  token: string
  expiresAt: number
  /** Whether the server already holds notes (decides whether a newly joined device keeps its starter data). */
  serverHasData: boolean
}

/** Sent over the event socket. The client authenticates with its first message. */
export type SocketMessage = { type: 'auth'; token: string } | { type: 'ready' } | { type: 'changed' }
