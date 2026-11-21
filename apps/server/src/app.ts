import { createHash } from 'node:crypto'
import { mkdir, rename, stat, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { join } from 'node:path'
import cors from '@fastify/cors'
import websocket from '@fastify/websocket'
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import type pg from 'pg'
import type { WebSocket } from 'ws'
import type {
  AccessRequest,
  PasskeyCreated,
  Session,
  SessionRequest,
  SignInRequest,
  SocketMessage,
  SyncRequest,
} from '@tdjr/core'
import {
  AttemptLimiter,
  MAX_WAITING_REQUESTS,
  deviceForToken,
  finishRequest,
  finishSignIn,
  liveTokenHashes,
  requestState,
  startRequest,
  startSignIn,
  waitingRequestCount,
  type Device,
  type PasskeyConfig,
  type Refusal,
} from './passkey'
import { BadRequest, hasNotes, sync } from './sync'

export interface AppOptions {
  pool: pg.Pool
  blobDir: string
  corsOrigins: string[]
  passkey: PasskeyConfig
  /** Behind a reverse proxy (Caddy), take the client address from X-Forwarded-For. */
  trustProxy?: boolean
  /** How often open sockets are checked against their sessions (tests shorten it). */
  socketCheckMs?: number
  logger?: boolean
}

const MB = 1024 * 1024
const HASH = /^[0-9a-f]{64}$/
/** A socket must authenticate this quickly. */
const SOCKET_AUTH_MS = 10_000

declare module 'fastify' {
  interface FastifyRequest {
    device: Device
  }
}

const isRefusal = (r: object): r is Refusal => 'refused' in r

export async function buildApp({ pool, blobDir, corsOrigins, passkey, trustProxy = false, socketCheckMs = 15_000, logger = false }: AppOptions) {
  await mkdir(blobDir, { recursive: true })
  const app = Fastify({ logger, bodyLimit: 32 * MB, trustProxy })
  await app.register(cors, { origin: corsOrigins, methods: ['GET', 'POST', 'PUT', 'DELETE'] })
  await app.register(websocket)
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 64 * MB }, (_req, body, done) =>
    done(null, body),
  )
  app.decorateRequest('device', null as unknown as Device)

  /** Failed sign-ins per address. */
  const signInLimiter = new AttemptLimiter()
  /** New access requests per address (each counts). */
  const requestLimiter = new AttemptLimiter(10, 60 * 60_000)
  /** Open event sockets, with their device and session, for "something changed" nudges. */
  const sockets = new Map<WebSocket, Device>()
  const notifyOthers = (deviceId: string) => {
    const msg = JSON.stringify({ type: 'changed' } satisfies SocketMessage)
    for (const [ws, d] of sockets) if (d.id !== deviceId && ws.readyState === ws.OPEN) ws.send(msg)
  }
  // Revocation happens in another process (admin.ts), so open sockets are checked against the database now
  // and then; expired or revoked ones are closed.
  const socketCheck = setInterval(() => {
    const open = [...sockets]
    liveTokenHashes(pool, open.map(([, d]) => d.tokenHash)).then(
      (live) => open.forEach(([ws, d]) => !live.has(d.tokenHash) && ws.close()),
      (err: unknown) => app.log.error(err),
    )
  }, socketCheckMs)
  app.addHook('onClose', async () => clearInterval(socketCheck))

  const requireDevice = async (req: FastifyRequest, reply: FastifyReply) => {
    const device = await deviceForToken(pool, req.headers.authorization)
    if (!device) return reply.code(401).send({ error: 'This device is signed out. Sign in again.' })
    req.device = device
  }
  const refused = (reply: FastifyReply, r: Refusal) =>
    reply.code(r.refused === 'unknown' ? 404 : 403).send({ error: r.message, status: r.refused })

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof BadRequest) return reply.code(400).send({ error: err.message })
    const { statusCode: status, message } = err as { statusCode?: number; message?: string }
    if (status && status < 500) return reply.code(status).send({ error: message })
    req.log.error(err)
    return reply.code(500).send({ error: 'The server hit an error. Try again.' })
  })

  app.get('/health', async () => ({ ok: true }))

  // ---------- Joining and signing in (passkeys; approval is admin.ts) ----------

  app.post<{ Body: AccessRequest }>('/devices/request', async (req, reply) => {
    if (requestLimiter.blocked(req.ip)) return reply.code(429).send({ error: 'Too many requests. Try again later.' })
    requestLimiter.fail(req.ip)
    if ((await waitingRequestCount(pool)) >= MAX_WAITING_REQUESTS) {
      return reply.code(429).send({ error: 'Too many requests are waiting for approval. Try again later.' })
    }
    return startRequest(pool, passkey, String(req.body?.deviceName ?? ''))
  })

  app.post<{ Params: { id: string }; Body: PasskeyCreated }>('/devices/request/:id/credential', async (req, reply) => {
    if (!req.body?.credentialId) return reply.code(400).send({ error: 'Send the new passkey.' })
    const result = await finishRequest(pool, passkey, req.params.id, req.body)
    return isRefusal(result) ? refused(reply, result) : result
  })

  app.get<{ Params: { id: string } }>('/devices/request/:id', async (req, reply) => {
    const result = await requestState(pool, req.params.id)
    return isRefusal(result) ? refused(reply, result) : result
  })

  app.post<{ Body: SignInRequest }>('/auth/challenge', async (req, reply) => {
    const result = await startSignIn(pool, passkey, String(req.body?.deviceId ?? ''))
    return isRefusal(result) ? refused(reply, result) : result
  })

  app.post<{ Body: SessionRequest }>('/auth/session', async (req, reply) => {
    if (signInLimiter.blocked(req.ip)) return reply.code(429).send({ error: 'Too many failed sign-ins. Wait a minute.' })
    if (!req.body?.assertion?.credentialId) return reply.code(400).send({ error: 'Send the passkey response.' })
    const result = await finishSignIn(pool, passkey, String(req.body.deviceId ?? ''), req.body.assertion)
    if (isRefusal(result)) {
      signInLimiter.fail(req.ip)
      return refused(reply, result)
    }
    const session: Session = { ...result, serverHasData: await hasNotes(pool) }
    return session
  })

  // ---------- Sync ----------

  app.post<{ Body: SyncRequest }>('/sync', { preHandler: requireDevice }, async (req) => {
    const { res, accepted } = await sync(pool, req.device.id, req.body)
    if (accepted > 0) notifyOthers(req.device.id)
    return res
  })

  // ---------- Attachments (content-addressed by SHA-256) ----------

  app.put<{ Params: { hash: string }; Body: Buffer }>('/blobs/:hash', { preHandler: requireDevice }, async (req, reply) => {
    const { hash } = req.params
    if (!HASH.test(hash)) return reply.code(400).send({ error: 'Not a SHA-256 hash.' })
    if (!Buffer.isBuffer(req.body)) return reply.code(400).send({ error: 'Send the file as application/octet-stream.' })
    if (createHash('sha256').update(req.body).digest('hex') !== hash) {
      return reply.code(400).send({ error: 'The file does not match its hash.' })
    }
    const path = join(blobDir, hash)
    const exists = await stat(path).then(() => true, () => false)
    if (!exists) {
      // Write then rename, so a reader never sees a partial file.
      const tmp = `${path}.${process.pid}.tmp`
      await writeFile(tmp, req.body)
      await rename(tmp, path)
    }
    await pool.query('INSERT INTO blob (hash, size, created_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [
      hash, req.body.length, Date.now(),
    ])
    return reply.code(204).send()
  })

  app.get<{ Params: { hash: string } }>('/blobs/:hash', { preHandler: requireDevice }, async (req, reply) => {
    const { hash } = req.params
    if (!HASH.test(hash)) return reply.code(400).send({ error: 'Not a SHA-256 hash.' })
    const path = join(blobDir, hash)
    const info = await stat(path).catch(() => null)
    if (!info) return reply.code(404).send({ error: 'No such attachment.' })
    return reply.header('content-type', 'application/octet-stream').header('content-length', info.size).send(createReadStream(path))
  })

  // ---------- Change notifications ----------

  app.get('/events', { websocket: true }, (socket) => {
    const timeout = setTimeout(() => socket.close(), SOCKET_AUTH_MS)
    socket.on('message', async (raw: Buffer) => {
      if (sockets.has(socket)) return
      let msg: SocketMessage
      try {
        msg = JSON.parse(raw.toString()) as SocketMessage
      } catch {
        return socket.close()
      }
      const device = msg.type === 'auth' ? await deviceForToken(pool, `Bearer ${msg.token}`) : null
      clearTimeout(timeout)
      if (!device) return socket.close()
      sockets.set(socket, device)
      socket.send(JSON.stringify({ type: 'ready' } satisfies SocketMessage))
    })
    socket.on('close', () => {
      clearTimeout(timeout)
      sockets.delete(socket)
    })
  })

  return app
}
