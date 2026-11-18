import type { NoteStore } from './store'
import type {
  DeviceCode,
  DeviceInfo,
  EnrollRequest,
  EnrollResponse,
  RecordChange,
  SocketMessage,
  SyncRequest,
  SyncResponse,
} from './syncProtocol'

// Talks to the sync server: push local changes, pull everyone else's, move attachment files, and stay current
// through a WebSocket that only says "something changed". Works offline: changes queue in the ledger and go
// out on the next successful sync.

const META = { server: 'server_url', device: 'device_id', token: 'device_token', name: 'device_name', cursor: 'cursor' }
const RECORDS_PER_PUSH = 500
const BODIES_PER_PUSH = 50
const BLOBS_PER_PASS = 20
const RETRY_MS = [2_000, 5_000, 15_000, 60_000]
/** A full sync now and then, in case a socket message was missed. */
const FALLBACK_SYNC_MS = 5 * 60_000

export interface SyncConfig {
  serverUrl: string
  deviceId: string
  deviceName: string
  token: string
}

export type SyncState = 'idle' | 'syncing' | 'offline' | 'error'

export interface SyncStatus {
  state: SyncState
  lastSyncAt: number | null
  /** What went wrong, for the user. */
  error: string | null
}

export class SyncHttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
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
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new SyncHttpError(res.status, body?.error ?? `The server answered ${res.status}.`)
  }
  return (res.status === 204 ? undefined : await res.json()) as T
}

/** The saved connection, or null when this device isn't connected to a server. */
export async function loadSyncConfig(store: NoteStore): Promise<SyncConfig | null> {
  const [serverUrl, deviceId, token, deviceName] = await Promise.all([
    store.ledger.getMeta(META.server),
    store.ledger.getMeta(META.device),
    store.ledger.getMeta(META.token),
    store.ledger.getMeta(META.name),
  ])
  return serverUrl && deviceId && token ? { serverUrl, deviceId, token, deviceName: deviceName ?? '' } : null
}

/**
 * Connects this device with a one-time code. If the server already has notes and this device has none, the
 * device's starter data (an empty notebook) is dropped so it doesn't duplicate; otherwise everything here is
 * queued for upload and merges with the server.
 */
export async function enrollDevice(
  store: NoteStore,
  serverUrl: string,
  code: string,
  deviceName: string,
  fetchFn: Fetch = fetch,
): Promise<SyncConfig> {
  const url = normalizeUrl(serverUrl)
  const req: EnrollRequest = { code: code.trim(), deviceName: deviceName.trim() || 'Device' }
  const res = await call<EnrollResponse>(fetchFn, `${url}/enroll`, { method: 'POST', json: req })
  if (res.serverHasData && !(await store.ledger.hasNotes())) await store.ledger.resetLocalData()
  else await store.ledger.seedAll()
  await store.ledger.setMeta(META.server, url)
  await store.ledger.setMeta(META.device, res.deviceId)
  await store.ledger.setMeta(META.token, res.token)
  await store.ledger.setMeta(META.name, req.deviceName)
  await store.ledger.setMeta(META.cursor, '0')
  store.emit({ type: 'remote', metadata: true, purged: [], bodies: new Map() })
  return { serverUrl: url, deviceId: res.deviceId, token: res.token, deviceName: req.deviceName }
}

/** Forgets the server connection. Notes stay on this device. */
export async function forgetSyncConfig(store: NoteStore): Promise<void> {
  for (const key of Object.values(META)) await store.ledger.deleteMeta(key)
}

export class SyncClient {
  private readonly store: NoteStore
  readonly config: SyncConfig
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
    opts: { fetch?: Fetch; WebSocket?: typeof WebSocket; debounceMs?: number } = {},
  ) {
    this.store = store
    this.config = config
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

  // ---------- Devices ----------

  createDeviceCode(): Promise<DeviceCode> {
    return this.api<DeviceCode>('/devices/code', { method: 'POST' })
  }

  listDevices(): Promise<DeviceInfo[]> {
    return this.api<DeviceInfo[]>('/devices')
  }

  revokeDevice(id: string): Promise<void> {
    return this.api<void>(`/devices/${encodeURIComponent(id)}`, { method: 'DELETE' })
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
    return call<T>(this.fetchFn, `${this.config.serverUrl}${path}`, { ...init, token: this.config.token })
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
        this.setStatus({ state: 'error', error: 'This device is no longer connected to the server. Connect it again from ⚙.' })
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
        headers: { authorization: `Bearer ${this.config.token}` },
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
    ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: this.config.token } satisfies SocketMessage))
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
