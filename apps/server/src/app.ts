import { createHash } from 'node:crypto'
import { mkdir, rename, stat, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { join } from 'node:path'
import cors from '@fastify/cors'
import websocket from '@fastify/websocket'
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import type pg from 'pg'
import type { WebSocket } from 'ws'
import { ulid } from 'ulid'
import type { DeviceInfo, EnrollRequest, EnrollResponse, SocketMessage, SyncRequest } from '@tdjr/core'
import {
  AttemptLimiter,
  DEVICE_CODE_TTL_MS,
  createEnrollCode,
  deviceForToken,
  newToken,
  normalizeCode,
  sha256,
  type Device,
} from './auth'
import { transaction } from './db'
import { BadRequest, hasNotes, sync } from './sync'

export interface AppOptions {
  pool: pg.Pool
  blobDir: string
  corsOrigins: string[]
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

export async function buildApp({ pool, blobDir, corsOrigins, logger = false }: AppOptions) {
  await mkdir(blobDir, { recursive: true })
  const app = Fastify({ logger, bodyLimit: 32 * MB })
  await app.register(cors, { origin: corsOrigins, methods: ['GET', 'POST', 'PUT', 'DELETE'] })
  await app.register(websocket)
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 64 * MB }, (_req, body, done) =>
    done(null, body),
  )
  app.decorateRequest('device', null as unknown as Device)

  const limiter = new AttemptLimiter()
  /** Open event sockets, by device, for "something changed" nudges. */
  const sockets = new Map<WebSocket, string>()
  const notifyOthers = (deviceId: string) => {
    const msg = JSON.stringify({ type: 'changed' } satisfies SocketMessage)
    for (const [ws, id] of sockets) if (id !== deviceId && ws.readyState === ws.OPEN) ws.send(msg)
  }

  const requireDevice = async (req: FastifyRequest, reply: FastifyReply) => {
    const device = await deviceForToken(pool, req.headers.authorization)
    if (!device) return reply.code(401).send({ error: 'This device is not connected. Connect it again with a new code.' })
    req.device = device
  }

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof BadRequest) return reply.code(400).send({ error: err.message })
    const { statusCode: status, message } = err as { statusCode?: number; message?: string }
    if (status && status < 500) return reply.code(status).send({ error: message })
    req.log.error(err)
    return reply.code(500).send({ error: 'The server hit an error. Try again.' })
  })

  app.get('/health', async () => ({ ok: true }))

  // ---------- Devices ----------

  app.post<{ Body: EnrollRequest }>('/enroll', async (req, reply) => {
    if (limiter.blocked(req.ip)) return reply.code(429).send({ error: 'Too many wrong codes. Wait a minute and try again.' })
    const code = normalizeCode(String(req.body?.code ?? ''))
    const name = String(req.body?.deviceName ?? '').trim().slice(0, 60) || 'Device'
    const token = newToken()
    const deviceId = await transaction(pool, async (db) => {
      const now = Date.now()
      const { rowCount } = await db.query(
        'UPDATE enroll_code SET used_at = $2 WHERE code_hash = $1 AND used_at IS NULL AND expires_at > $2',
        [sha256(code), now],
      )
      if (!rowCount) return null
      const id = ulid()
      await db.query('INSERT INTO device (id, name, token_hash, created_at) VALUES ($1, $2, $3, $4)', [id, name, sha256(token), now])
      return id
    })
    if (!deviceId) {
      limiter.fail(req.ip)
      return reply.code(400).send({ error: 'That code is wrong or has expired. Get a new one and try again.' })
    }
    const res: EnrollResponse = { deviceId, token, serverHasData: await hasNotes(pool) }
    return res
  })

  app.post('/devices/code', { preHandler: requireDevice }, async (req) =>
    createEnrollCode(pool, { createdBy: req.device.id, ttlMs: DEVICE_CODE_TTL_MS }),
  )

  app.get('/devices', { preHandler: requireDevice }, async (req) => {
    const { rows } = await pool.query<{ id: string; name: string; created_at: string; last_seen_at: string | null }>(
      'SELECT id, name, created_at, last_seen_at FROM device WHERE revoked_at IS NULL ORDER BY created_at',
    )
    return rows.map(
      (r): DeviceInfo => ({
        id: r.id,
        name: r.name,
        createdAt: Number(r.created_at),
        lastSeenAt: r.last_seen_at === null ? null : Number(r.last_seen_at),
        current: r.id === req.device.id,
      }),
    )
  })

  app.delete<{ Params: { id: string } }>('/devices/:id', { preHandler: requireDevice }, async (req, reply) => {
    await pool.query('UPDATE device SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL', [req.params.id, Date.now()])
    for (const [ws, id] of sockets) if (id === req.params.id) ws.close()
    return reply.code(204).send()
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
      sockets.set(socket, device.id)
      socket.send(JSON.stringify({ type: 'ready' } satisfies SocketMessage))
    })
    socket.on('close', () => {
      clearTimeout(timeout)
      sockets.delete(socket)
    })
  })

  return app
}
