import type { NoteStore } from './store'
import type {
  AccessRequest,
  AccessRequestStarted,
  AccessRequestState,
  AccessStatus,
  PasskeyAssertion,
  PasskeyCreateOptions,
  PasskeyCreated,
  PasskeyGetOptions,
  RecordChange,
  Session,
  SessionRequest,
  SocketMessage,
  SyncRequest,
  SyncResponse,
} from './syncProtocol'

// Talks to the sync server: push local changes, pull everyone else's, move attachment files, and stay current
// through a WebSocket that only says "something changed". Works offline: changes queue in the ledger and go
// out on the next successful sync.
//
// Joining and signing in use this device's own passkey (docs/passkeys.md). The session token from signing in
// lives only in memory; nothing reusable is written to disk.

const META = { server: 'server_url', device: 'device_id', name: 'device_name', cursor: 'cursor', joined: 'joined' }
/** Written by versions that joined with codes; deleted on sight. */
const LEGACY_TOKEN_KEY = 'device_token'
const RECORDS_PER_PUSH = 500
const BODIES_PER_PUSH = 50
const BLOBS_PER_PASS = 20
const RETRY_MS = [2_000, 5_000, 15_000, 60_000]
/** A full sync now and then, in case a socket message was missed. */
const FALLBACK_SYNC_MS = 5 * 60_000

export interface SyncConfig {
  serverUrl: string
  /** Also the access request's id. */
  deviceId: string
  deviceName: string
}

/** Creates and uses this device's passkey: Windows Hello through Tauri, or navigator.credentials in a browser. */
export interface Passkeys {
  /** `origin` is the server's origin, which native authenticators put in the client data. Browsers use the page's. */
  create(options: PasskeyCreateOptions, origin: string): Promise<PasskeyCreated>
  get(options: PasskeyGetOptions, origin: string): Promise<PasskeyAssertion>
}

/** `signed-out`: the session expired or the device was revoked; sign in again (or request access again). */
export type SyncState = 'idle' | 'syncing' | 'offline' | 'error' | 'signed-out'

export interface SyncStatus {
  state: SyncState
  lastSyncAt: number | null
  /** What went wrong, for the user. */
  error: string | null
}

export class SyncHttpError extends Error {
  readonly status: number
  /** Why the server refused this device, when it did (403/404 from the join and sign-in routes). */
  readonly refused: AccessStatus | 'unknown' | undefined
  constructor(status: number, message: string, refused?: AccessStatus | 'unknown') {
    super(message)
    this.status = status
    this.refused = refused
  }
}

type Fetch = typeof fetch

const normalizeUrl = (url: string) => url.trim().replace(/\/+$/, '')

async function call<T>(fetchFn: Fetch, url: string, init: RequestInit & { token?: string; json?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = {}
  if (init.token) headers.authorization = `Bearer ${init.token}`
  if (init.json !== undefined) headers['content-type'] = 'application/json'
  const res = await fetchFn(url, { ...init, headers: { ...headers, ...(init.headers as Record<string, string>) }, body: init.json !== undefined ? JSON.stringify(init.json) : init.body })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string; status?: AccessStatus | 'unknown' } | null
    throw new SyncHttpError(res.status, body?.error ?? `The server answered ${res.status}.`, body?.status)
  }
  return (res.status === 204 ? undefined : await res.json()) as T
}

/** The saved connection (possibly still waiting for approval), or null when this device hasn't asked to join. */
export async function loadSyncConfig(store: NoteStore): Promise<SyncConfig | null> {
  await store.ledger.deleteMeta(LEGACY_TOKEN_KEY)
  const [serverUrl, deviceId, deviceName] = await Promise.all([
    store.ledger.getMeta(META.server),
    store.ledger.getMeta(META.device),
    store.ledger.getMeta(META.name),
  ])
  return serverUrl && deviceId ? { serverUrl, deviceId, deviceName: deviceName ?? '' } : null
}

const originOf = (serverUrl: string) => new URL(serverUrl).origin

/**
 * Asks to join: creates this device's passkey and sends its public half. The device then waits for an admin to
 * approve the request on the server, by the match code returned here.
 */
export async function requestAccess(
  store: NoteStore,
  serverUrl: string,
  deviceName: string,
  passkeys: Passkeys,
  fetchFn: Fetch = fetch,
): Promise<{ config: SyncConfig; state: AccessRequestState }> {
  const url = normalizeUrl(serverUrl)
  const req: AccessRequest = { deviceName: deviceName.trim() || 'Device' }
  const started = await call<AccessRequestStarted>(fetchFn, `${url}/devices/request`, { method: 'POST', json: req })
  const created = await passkeys.create(started.options, originOf(url))
  const state = await call<AccessRequestState>(fetchFn, `${url}/devices/request/${started.requestId}/credential`, {
    method: 'POST',
    json: created,
  })
  await forgetSyncConfig(store)
  await store.ledger.setMeta(META.server, url)
  await store.ledger.setMeta(META.device, started.requestId)
  await store.ledger.setMeta(META.name, req.deviceName)
  return { config: { serverUrl: url, deviceId: started.requestId, deviceName: req.deviceName }, state }
}

export type Refused = { status: AccessStatus | 'unknown'; message: string }

/** Where this device's request stands. A refusal (denied, revoked, expired, unknown) comes back as a state too. */
export async function accessState(config: SyncConfig, fetchFn: Fetch = fetch): Promise<AccessRequestState | Refused> {
  try {
    return await call<AccessRequestState>(fetchFn, `${config.serverUrl}/devices/request/${config.deviceId}`)
  } catch (err) {
    if (err instanceof SyncHttpError && err.refused) return { status: err.refused, message: err.message }
    throw err
  }
}

/**
 * Signs in with this device's passkey and returns a session for SyncClient. The challenge is fetched first,
 * so an unreachable server never shows a passkey prompt. The first sign-in after approval joins the device:
 * if the server already has notes and this device has none, its starter data is dropped so it doesn't
 * duplicate; otherwise everything here is queued for upload and merges with the server.
 */
export async function signIn(store: NoteStore, config: SyncConfig, passkeys: Passkeys, fetchFn: Fetch = fetch): Promise<Session> {
  const options = await call<PasskeyGetOptions>(fetchFn, `${config.serverUrl}/auth/challenge`, {
    method: 'POST',
    json: { deviceId: config.deviceId },
  })
  const assertion = await passkeys.get(options, originOf(config.serverUrl))
  const req: SessionRequest = { deviceId: config.deviceId, assertion }
  const session = await call<Session>(fetchFn, `${config.serverUrl}/auth/session`, { method: 'POST', json: req })
  if ((await store.ledger.getMeta(META.joined)) !== config.deviceId) {
    if (session.serverHasData && !(await store.ledger.hasNotes())) await store.ledger.resetLocalData()
    else await store.ledger.seedAll()
    await store.ledger.setMeta(META.cursor, '0')
    await store.ledger.setMeta(META.joined, config.deviceId)
    store.emit({ type: 'remote', metadata: true, purged: [], bodies: new Map() })
  }
  return session
}

/** Forgets the server connection. Notes stay on this device. */
export async function forgetSyncConfig(store: NoteStore): Promise<void> {
  for (const key of [...Object.values(META), LEGACY_TOKEN_KEY]) await store.ledger.deleteMeta(key)
}

export class SyncClient {
  private readonly store: NoteStore
  readonly config: SyncConfig
  private readonly token: string
  private readonly fetchFn: Fetch
  private readonly WebSocketImpl: typeof WebSocket | undefined
  private readonly debounceMs: number
  private status: SyncStatus = { state: 'idle', lastSyncAt: null, error: null }
  private readonly statusListeners = new Set<(s: SyncStatus) => void>()
  private running: Promise<void> | null = null
  private again = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private fallback: ReturnType<typeof setInterval> | undefined
  private socket: WebSocket | null = null
  private socketRetry = 0
  private retry = 0
  private started = false
  private unsubscribe: (() => void) | null = null

  constructor(
    store: NoteStore,
    config: SyncConfig,
    session: Pick<Session, 'token'>,
    opts: { fetch?: Fetch; WebSocket?: typeof WebSocket; debounceMs?: number } = {},
  ) {
    this.store = store
    this.config = config
    this.token = session.token
    this.fetchFn = opts.fetch ?? ((input, init) => fetch(input, init))
    this.WebSocketImpl = opts.WebSocket ?? (typeof WebSocket === 'undefined' ? undefined : WebSocket)
    this.debounceMs = opts.debounceMs ?? 800
  }

  /** Syncs now, then after every local change and every change announced by the server. */
  start(): void {
    if (this.started) return
    this.started = true
    this.unsubscribe = this.store.onChange((e) => e.type === 'local' && this.schedule(this.debounceMs))
    this.fallback = setInterval(() => this.schedule(0), FALLBACK_SYNC_MS)
    this.openSocket()
    this.schedule(0)
  }

  stop(): void {
    this.started = false
    this.unsubscribe?.()
    this.unsubscribe = null
    clearTimeout(this.timer)
    clearInterval(this.fallback)
    this.socket?.close()
    this.socket = null
  }

  getStatus(): SyncStatus {
    return this.status
  }

  onStatus(listener: (s: SyncStatus) => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  /** Runs a full sync; a call while one is running makes it go round once more. */
  syncNow(): Promise<void> {
    if (this.running) {
      this.again = true
      return this.running
    }
    this.running = this.run().finally(() => {
      this.running = null
    })
    return this.running
  }

  // ---------- Internals ----------

  private schedule(delay: number) {
    if (!this.started) return
    clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.syncNow(), delay)
  }

  private setStatus(patch: Partial<SyncStatus>) {
    this.status = { ...this.status, ...patch }
    for (const l of this.statusListeners) l(this.status)
  }

  private api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
    return call<T>(this.fetchFn, `${this.config.serverUrl}${path}`, { ...init, token: this.token })
  }

  private async run(): Promise<void> {
    this.setStatus({ state: 'syncing', error: null })
    try {
      do {
        this.again = false
        await this.pushPull()
        await this.downloadBlobs()
      } while (this.again)
      this.retry = 0
      this.setStatus({ state: 'idle', lastSyncAt: Date.now(), error: null })
    } catch (err) {
      if (err instanceof SyncHttpError && err.status === 401) {
        this.setStatus({ state: 'signed-out', error: 'Signed out of the server. Sign in again from ⚙.' })
        this.stop()
        return
      }
      const offline = !(err instanceof SyncHttpError)
      this.setStatus({
        state: offline ? 'offline' : 'error',
        error: offline ? 'Can’t reach the server. Changes are kept here and sync when it’s back.' : (err as Error).message,
      })
      this.schedule(RETRY_MS[Math.min(this.retry++, RETRY_MS.length - 1)])
    }
  }

  private async pushPull(): Promise<void> {
    const { ledger } = this.store
    for (;;) {
      const records = await ledger.pendingRecords(RECORDS_PER_PUSH)
      const bodies = await ledger.pendingBodies(BODIES_PER_PUSH)
      await this.uploadBlobs(records)
      const since = Number((await ledger.getMeta(META.cursor)) ?? '0')
      const req: SyncRequest = { since, records, updates: bodies.map((b) => ({ noteId: b.noteId, data: b.data })) }
      const res = await this.api<SyncResponse>('/sync', { method: 'POST', json: req })
      await ledger.markPushed(records)
      await ledger.markBodiesPushed(bodies)

      const { metadata, purged } = await ledger.applyRecords(res.records)
      const touched = await ledger.applyBodies(res.updates)
      await ledger.setMeta(META.cursor, String(res.cursor))
      if (metadata || touched.size > 0) this.store.emit({ type: 'remote', metadata, purged, bodies: touched })

      const more = records.length === RECORDS_PER_PUSH || bodies.length === BODIES_PER_PUSH || res.hasMore
      if (!more) return
    }
  }

  /** Attachment files go up before their records, so other devices can always fetch what they're told about. */
  private async uploadBlobs(records: RecordChange[]): Promise<void> {
    const hashes = new Set(records.filter((r) => r.kind === 'attachment').map((r) => r.id))
    for (const hash of hashes) {
      const bytes = await this.store.blobs.read(hash)
      if (!bytes) continue
      await this.api<void>(`/blobs/${hash}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: bytes as Uint8Array<ArrayBuffer>,
      })
    }
  }

  private async downloadBlobs(): Promise<void> {
    const { ledger } = this.store
    for (const hash of await ledger.missingBlobs(BLOBS_PER_PASS)) {
      const res = await this.fetchFn(`${this.config.serverUrl}/blobs/${hash}`, {
        headers: { authorization: `Bearer ${this.token}` },
      })
      if (res.status === 404) continue
      if (!res.ok) throw new SyncHttpError(res.status, `Downloading an attachment failed (${res.status}).`)
      await this.store.blobs.put(hash, new Uint8Array(await res.arrayBuffer()))
      await ledger.blobArrived(hash)
    }
  }

  private openSocket(): void {
    if (!this.started || !this.WebSocketImpl) return
    const ws = new this.WebSocketImpl(`${this.config.serverUrl.replace(/^http/, 'ws')}/events`)
    this.socket = ws
    ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: this.token } satisfies SocketMessage))
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as SocketMessage
      if (msg.type === 'ready') {
        this.socketRetry = 0
        // Catch up on anything missed while the socket was down.
        this.schedule(0)
      } else if (msg.type === 'changed') {
        this.schedule(50)
      }
    }
    ws.onclose = () => {
      if (this.socket !== ws) return
      this.socket = null
      if (this.started) setTimeout(() => this.openSocket(), RETRY_MS[Math.min(this.socketRetry++, RETRY_MS.length - 1)])
    }
    ws.onerror = () => ws.close()
  }
}
