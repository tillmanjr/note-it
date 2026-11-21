// End to end: real server and Postgres, with devices that are full NoteStores on in-memory SQLite and a
// software passkey each. Needs the docker-compose database (npm run db:up -w @tdjr/server); skipped when it
// isn't reachable. Uses its own database (notes_test), recreated for every test.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import pg from 'pg'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  NoteStore,
  SyncClient,
  SyncHttpError,
  accessState,
  bodyText,
  requestAccess,
  signIn,
  type BlobStore,
  type SqlDriver,
} from '@tdjr/core'
import { buildApp } from './app'
import { createPool, migrate } from './db'
import { approvedDevices, decideRequest, revokeDevice, type PasskeyConfig } from './passkey'
import { softPasskeys } from './softPasskeys'

const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://notes:notes@localhost:5320/notes'
const TEST_URL = process.env.TEST_DATABASE_URL ?? 'postgres://notes:notes@localhost:5320/notes_test'

async function prepareDatabase(): Promise<boolean> {
  const admin = new pg.Client({ connectionString: ADMIN_URL, connectionTimeoutMillis: 2000 })
  try {
    await admin.connect()
    const { rowCount } = await admin.query(`SELECT 1 FROM pg_database WHERE datname = 'notes_test'`)
    if (!rowCount) await admin.query('CREATE DATABASE notes_test')
    return true
  } catch {
    return false
  } finally {
    await admin.end().catch(() => {})
  }
}

const available = await prepareDatabase()

function memoryDriver(): SqlDriver {
  const db = new DatabaseSync(':memory:')
  return {
    async execute(sql, params = []) {
      db.prepare(sql).run(...(params as never[]))
    },
    async select<T>(sql: string, params: unknown[] = []) {
      return db.prepare(sql).all(...(params as never[])) as T[]
    },
  }
}

function memoryBlobs(): BlobStore & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>()
  return {
    files,
    has: async (hash) => files.has(hash),
    put: async (hash, bytes) => void files.set(hash, bytes),
    read: async (hash) => files.get(hash) ?? null,
    url: (hash) => `blob://${hash}`,
  }
}

async function newDevice() {
  const blobs = memoryBlobs()
  const store = new NoteStore(memoryDriver(), blobs)
  await store.migrate()
  return { store, blobs, passkeys: softPasskeys() }
}

type TestDevice = Awaited<ReturnType<typeof newDevice>>

/** Appends a paragraph to a note body, the way the editor would. */
async function addParagraph(store: NoteStore, noteId: string, text: string) {
  const doc = new Y.Doc()
  const body = await store.loadNoteBody(noteId)
  if (body) Y.applyUpdate(doc, body)
  const before = Y.encodeStateVector(doc)
  const p = new Y.XmlElement('paragraph')
  p.insert(0, [new Y.XmlText(text)])
  doc.getXmlFragment('body').push([p])
  await store.appendNoteUpdate(noteId, Y.encodeStateAsUpdate(doc, before))
}

async function textOf(store: NoteStore, noteId: string) {
  const body = await store.loadNoteBody(noteId)
  return body ? bodyText(body) : ''
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function until(check: () => Promise<boolean>, ms = 4000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await sleep(25)
  }
  throw new Error('Timed out waiting for the condition.')
}

/** Why the server refused, or "accepted". */
const refusalOf = (p: Promise<unknown>) =>
  p.then(
    () => 'accepted',
    (e: unknown) => (e instanceof SyncHttpError ? (e.refused ?? `http ${e.status}`) : String(e)),
  )

describe.skipIf(!available)('sync server end to end', () => {
  const pool = createPool(TEST_URL)
  let app: Awaited<ReturnType<typeof buildApp>>
  let url = ''
  let blobDir = ''
  const clients: SyncClient[] = []
  const passkey: PasskeyConfig = { rpId: 'localhost', rpName: 'Notes', origins: [] }

  beforeEach(async () => {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
    await migrate(pool)
    blobDir = await mkdtemp(join(tmpdir(), 'notes-blobs-'))
    app = await buildApp({ pool, blobDir, corsOrigins: [], passkey, socketCheckMs: 50 })
    await app.listen({ host: '127.0.0.1', port: 0 })
    const addr = app.server.address()
    url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
    passkey.origins = [url]
  })

  afterEach(async () => {
    for (const c of clients.splice(0)) c.stop()
    await app.close()
    await rm(blobDir, { recursive: true, force: true })
  })

  afterAll(async () => {
    await pool.end()
  })

  /** Requests access, approves it as the admin would, signs in, and returns a client (socket optional). */
  async function connect(device: TestDevice, name: string, socket = false) {
    const { config, state } = await requestAccess(device.store, url, name, device.passkeys)
    await decideRequest(pool, state.matchCode, 'approved')
    const session = await signIn(device.store, config, device.passkeys)
    const client = new SyncClient(device.store, config, session, { WebSocket: socket ? WebSocket : undefined, debounceMs: 10 })
    clients.push(client)
    return { config, client }
  }

  it('uploads the first device and downloads everything to a fresh one', async () => {
    const a = await newDevice()
    const nb = await a.store.createNotebook('Recipes')
    const tag = await a.store.createTag('food')
    const note = await a.store.createNote(nb.id, 'Pancakes')
    await a.store.setNoteTags(note.id, [tag.id])
    await addParagraph(a.store, note.id, 'Flour, eggs and milk')
    const att = await a.store.putAttachment(new Uint8Array([1, 2, 3, 4]), 'image/png', 'photo.png')
    const { client: ca } = await connect(a, 'Desktop')
    await ca.syncNow()
    expect(ca.getStatus().state).toBe('idle')

    // A fresh device starts with an empty "Notes" notebook, like the app; it's dropped on joining.
    const b = await newDevice()
    await b.store.createNotebook('Notes')
    const { client: cb } = await connect(b, 'Phone')
    await cb.syncNow()

    expect((await b.store.listNotebooks()).map((n) => n.name)).toEqual(['Recipes'])
    const [copy] = await b.store.queryNotes()
    expect(copy).toMatchObject({ id: note.id, title: 'Pancakes', notebookId: nb.id, tagIds: [tag.id] })
    expect(await textOf(b.store, note.id)).toBe('Flour, eggs and milk')
    expect((await b.store.searchNotes('eggs')).map((h) => h.note.id)).toEqual([note.id])
    expect(b.blobs.files.get(att.hash)).toEqual(new Uint8Array([1, 2, 3, 4]))
    expect((await approvedDevices(pool)).map((d) => d.name)).toEqual(['Desktop', 'Phone'])
  })

  it('merges offline edits to the same note; the newest title wins', async () => {
    const a = await newDevice()
    const nb = await a.store.createNotebook('Work')
    const note = await a.store.createNote(nb.id, 'Plan')
    await addParagraph(a.store, note.id, 'Intro')
    const { client: ca } = await connect(a, 'A')
    await ca.syncNow()
    const b = await newDevice()
    const { client: cb } = await connect(b, 'B')
    await cb.syncNow()

    // Both edit while "offline", then sync.
    await addParagraph(a.store, note.id, 'From A')
    await a.store.setNoteTitle(note.id, 'Title from A')
    await sleep(5)
    await addParagraph(b.store, note.id, 'From B')
    await b.store.setNoteTitle(note.id, 'Title from B')
    await ca.syncNow()
    await cb.syncNow()
    await ca.syncNow()

    for (const d of [a, b]) {
      const text = await textOf(d.store, note.id)
      expect(text).toContain('Intro')
      expect(text).toContain('From A')
      expect(text).toContain('From B')
      expect((await d.store.getNote(note.id))?.title).toBe('Title from B')
    }
    expect(await textOf(a.store, note.id)).toBe(await textOf(b.store, note.id))
  })

  it('deletes forever everywhere, even against a late edit from another device', async () => {
    const a = await newDevice()
    const nb = await a.store.createNotebook('Old')
    const note = await a.store.createNote(nb.id, 'Draft')
    await addParagraph(a.store, note.id, 'text')
    const { client: ca } = await connect(a, 'A')
    await ca.syncNow()
    const b = await newDevice()
    const { client: cb } = await connect(b, 'B')
    await cb.syncNow()

    await addParagraph(b.store, note.id, 'late edit') // not synced yet
    await a.store.trashNote(note.id)
    expect(await a.store.emptyTrash()).toBe(1)
    await ca.syncNow()
    await cb.syncNow()
    await ca.syncNow()

    expect(await a.store.getNote(note.id)).toBeNull()
    expect(await b.store.getNote(note.id)).toBeNull()
    const { rowCount } = await pool.query('SELECT 1 FROM body_update WHERE note_id = $1', [note.id])
    expect(rowCount).toBe(0)
  })

  it('nudges other devices through the event socket', async () => {
    const a = await newDevice()
    const { client: ca } = await connect(a, 'A')
    const b = await newDevice()
    const { client: cb } = await connect(b, 'B', true)
    cb.start()
    await until(async () => cb.getStatus().lastSyncAt !== null)

    await a.store.createNotebook('Shared')
    await ca.syncNow()
    await until(async () => (await b.store.listNotebooks()).some((n) => n.name === 'Shared'))
  })

  it('waits for approval, and only the matching code approves', async () => {
    const a = await newDevice()
    const { config, state } = await requestAccess(a.store, url, 'Laptop', a.passkeys)
    expect(state).toMatchObject({ status: 'pending', matchCode: expect.stringMatching(/^[A-Z2-9]{3}-[A-Z2-9]{3}$/) })
    expect(await accessState(config)).toEqual(state)
    expect(await refusalOf(signIn(a.store, config, a.passkeys))).toBe('pending')

    await expect(decideRequest(pool, 'AAA-AAA', 'approved')).rejects.toThrow(/No pending request/)
    await decideRequest(pool, state.matchCode.toLowerCase().replace('-', ' '), 'approved')
    expect((await accessState(config)).status).toBe('approved')
    const session = await signIn(a.store, config, a.passkeys)
    expect(session.expiresAt).toBeGreaterThan(Date.now())
    // Nothing is left pending to approve.
    await expect(decideRequest(pool, state.matchCode, 'approved')).rejects.toThrow(/No pending request/)
  })

  it('keeps denied, revoked and unknown devices out', async () => {
    const a = await newDevice()
    const denied = await requestAccess(a.store, url, 'Stranger', a.passkeys)
    await decideRequest(pool, denied.state.matchCode, 'denied')
    expect((await accessState(denied.config)).status).toBe('denied')
    expect(await refusalOf(signIn(a.store, denied.config, a.passkeys))).toBe('denied')

    const b = await newDevice()
    const { client: cb, config } = await connect(b, 'B')
    await cb.syncNow()
    await revokeDevice(pool, config.deviceId.slice(0, 12))
    await cb.syncNow()
    expect(cb.getStatus().state).toBe('signed-out')
    expect(await refusalOf(signIn(b.store, config, b.passkeys))).toBe('revoked')

    const unknown = { ...config, deviceId: '01JUNKJUNKJUNKJUNKJUNKJUNK' }
    expect((await accessState(unknown)).status).toBe('unknown')
    expect(await refusalOf(signIn(b.store, unknown, b.passkeys))).toBe('unknown')
  })

  it('closes the event socket of a revoked device', async () => {
    const a = await newDevice()
    const { config } = await connect(a, 'A')
    const session = await signIn(a.store, config, a.passkeys)
    const ws = new WebSocket(`${url.replace('http', 'ws')}/events`)
    const ready = new Promise<void>((resolve) => (ws.onmessage = () => resolve()))
    const closed = new Promise<void>((resolve) => (ws.onclose = () => resolve()))
    ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: session.token }))
    await ready
    await revokeDevice(pool, config.deviceId)
    await closed
  })

  it('rejects a forged signature, a replayed sign-in, and another device’s passkey', async () => {
    const a = await newDevice()
    const { config } = await connect(a, 'A')

    // Forged: one bit of the signature flipped.
    const forging = {
      ...a.passkeys,
      get: async (...args: Parameters<typeof a.passkeys.get>) => {
        const assertion = await a.passkeys.get(...args)
        const sig = Buffer.from(assertion.signature, 'base64url')
        sig[sig.length - 1] ^= 1
        return { ...assertion, signature: sig.toString('base64url') }
      },
    }
    expect(await refusalOf(signIn(a.store, config, forging))).toBe('approved')

    // Replayed: the same signed answer sent twice. The challenge was used up the first time.
    let sent: string | undefined
    const recording: typeof fetch = (input, init) => {
      if (String(input).endsWith('/auth/session')) sent = String(init?.body)
      return fetch(input, init)
    }
    await signIn(a.store, config, a.passkeys, recording)
    const replay = await fetch(`${url}/auth/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: sent })
    expect(replay.status).toBe(403)

    // Another approved device's passkey can't sign in as this device.
    const b = await newDevice()
    const other = await requestAccess(b.store, url, 'B', b.passkeys)
    await decideRequest(pool, other.state.matchCode, 'approved')
    const wrongKey = {
      ...b.passkeys,
      get: (o: Parameters<typeof b.passkeys.get>[0], origin: string) =>
        b.passkeys.get({ ...o, allowCredentials: [...b.passkeys.keys.keys()] }, origin),
    }
    expect(await refusalOf(signIn(a.store, config, wrongKey))).toBe('approved')
  })

  it('signs out a device whose session expired', async () => {
    const a = await newDevice()
    const { client } = await connect(a, 'A')
    await client.syncNow()
    expect(client.getStatus().state).toBe('idle')
    await pool.query('UPDATE session SET expires_at = 0')
    await client.syncNow()
    expect(client.getStatus().state).toBe('signed-out')
  })

  it('deletes a token left by the code-based version', async () => {
    const a = await newDevice()
    await a.store.ledger.setMeta('device_token', 'old-secret')
    await connect(a, 'A')
    expect(await a.store.ledger.getMeta('device_token')).toBeNull()
  })
})
