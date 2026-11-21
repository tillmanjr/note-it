import { createHash, randomBytes } from 'node:crypto'
import { verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server'
import type pg from 'pg'
import { ulid } from 'ulid'
import type {
  AccessRequestStarted,
  AccessRequestState,
  AccessStatus,
  PasskeyAssertion,
  PasskeyCreated,
  PasskeyGetOptions,
  Session,
} from '@tdjr/core'

// Devices join and sign in with their own passkeys (see docs/passkeys.md):
//   request:  the device registers a passkey; the device row becomes `pending`.
//   approve:  an admin approves it on the server (admin.ts); the app itself can't.
//   sign in:  on each launch the device proves it holds the passkey and gets a short-lived session token.
// Only SHA-256 hashes of session tokens are stored. Challenges are single use.

export interface PasskeyConfig {
  /** The WebAuthn relying party id: the server's domain (`localhost` in development). */
  rpId: string
  rpName: string
  /** Origins a passkey response may come from (the browser dev build, and the server's own origin for native clients). */
  origins: string[]
}

export const REQUEST_TTL_MS = 7 * 24 * 60 * 60_000
export const SESSION_TTL_MS = 24 * 60 * 60_000
const CHALLENGE_TTL_MS = 5 * 60_000
/** A request whose passkey never arrived is dropped after this. */
const UNFINISHED_REQUEST_MS = 60 * 60_000
/** Requests waiting at once, so a flood can't fill the admin's list. */
export const MAX_WAITING_REQUESTS = 20

/** Unambiguous characters (no 0/O, 1/I/L) so codes are easy to read and compare. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

export const newToken = () => randomBytes(32).toString('base64url')

/** A short code like "K7F-2QM" derived from the passkey, shown on the device and to the admin. */
export function matchCode(credentialId: string): string {
  const bytes = createHash('sha256').update(credentialId).digest()
  const chars = Array.from(bytes.subarray(0, 6), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('')
  return `${chars.slice(0, 3)}-${chars.slice(3)}`
}

/** Normalizes a typed code: case, spaces and dashes don't matter. */
export const normalizeCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '')

type Db = pg.Pool | pg.PoolClient

export type Refusal = { refused: AccessStatus | 'unknown'; message: string }

const refusalMessages: Record<Refusal['refused'], string> = {
  pending: 'This device is waiting for approval.',
  approved: 'This device is already approved.',
  denied: 'This device was denied access. Request access again if that was a mistake.',
  revoked: 'This device was disconnected. Request access again.',
  expired: 'This request expired before it was approved. Request access again.',
  unknown: 'The server does not know this device. Request access again.',
}
const refuse = (refused: Refusal['refused']): Refusal => ({ refused, message: refusalMessages[refused] })

interface DeviceRow {
  id: string
  name: string
  status: string
  created_at: string
  credential_id: string | null
  public_key: Buffer | null
  sign_count: string
  transports: string | null
  match_code: string | null
}

function statusOf(row: DeviceRow, now: number): AccessStatus | 'unknown' {
  if (row.status === 'pending' && now - Number(row.created_at) > REQUEST_TTL_MS) return 'expired'
  if (row.status === 'new') return 'unknown'
  return row.status as AccessStatus
}

async function getDevice(db: Db, id: string): Promise<DeviceRow | null> {
  const { rows } = await db.query<DeviceRow>('SELECT * FROM device WHERE id = $1', [String(id)])
  return rows[0] ?? null
}

async function newChallenge(db: Db, deviceId: string, purpose: 'register' | 'sign-in', now: number): Promise<string> {
  const challenge = randomBytes(32).toString('base64url')
  await db.query(
    `INSERT INTO challenge (device_id, purpose, challenge, expires_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (device_id, purpose) DO UPDATE SET challenge = EXCLUDED.challenge, expires_at = EXCLUDED.expires_at`,
    [deviceId, purpose, challenge, now + CHALLENGE_TTL_MS],
  )
  return challenge
}

/** Takes the device's open challenge, so it can be answered only once. */
async function takeChallenge(db: Db, deviceId: string, purpose: 'register' | 'sign-in', now: number): Promise<string | null> {
  const { rows } = await db.query<{ challenge: string; expires_at: string }>(
    'DELETE FROM challenge WHERE device_id = $1 AND purpose = $2 RETURNING challenge, expires_at',
    [deviceId, purpose],
  )
  const row = rows[0]
  return row && Number(row.expires_at) > now ? row.challenge : null
}

/** Requests that are waiting (unfinished or pending, not expired). */
export async function waitingRequestCount(db: Db, now = Date.now()): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*) AS n FROM device WHERE (status = 'new' AND created_at > $1) OR (status = 'pending' AND created_at > $2)`,
    [now - UNFINISHED_REQUEST_MS, now - REQUEST_TTL_MS],
  )
  return Number(rows[0].n)
}

export async function startRequest(db: Db, config: PasskeyConfig, deviceName: string, now = Date.now()): Promise<AccessRequestStarted> {
  await db.query(`DELETE FROM device WHERE status = 'new' AND created_at <= $1`, [now - UNFINISHED_REQUEST_MS])
  const id = ulid()
  const name = deviceName.trim().slice(0, 60) || 'Device'
  await db.query(`INSERT INTO device (id, name, status, created_at) VALUES ($1, $2, 'new', $3)`, [id, name, now])
  const challenge = await newChallenge(db, id, 'register', now)
  return {
    requestId: id,
    options: {
      rpId: config.rpId,
      rpName: config.rpName,
      userId: Buffer.from(id).toString('base64url'),
      userName: name,
      challenge,
      timeoutMs: CHALLENGE_TTL_MS,
    },
  }
}

export async function finishRequest(
  db: Db,
  config: PasskeyConfig,
  requestId: string,
  created: PasskeyCreated,
  now = Date.now(),
): Promise<AccessRequestState | Refusal> {
  const device = await getDevice(db, requestId)
  if (!device || device.status !== 'new') return refuse(device ? statusOf(device, now) : 'unknown')
  const challenge = await takeChallenge(db, device.id, 'register', now)
  if (!challenge) return refuse('expired')
  const result = await verifyRegistrationResponse({
    response: {
      id: String(created.credentialId),
      rawId: String(created.credentialId),
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: String(created.clientDataJSON),
        attestationObject: String(created.attestationObject),
        transports: created.transports as never,
      },
    },
    expectedChallenge: challenge,
    expectedOrigin: config.origins,
    expectedRPID: config.rpId,
    requireUserVerification: true,
  }).catch(() => ({ verified: false as const }))
  if (!result.verified) return { refused: 'unknown', message: 'The passkey could not be verified. Request access again.' }
  const { credential } = result.registrationInfo
  const code = matchCode(credential.id)
  await db.query(
    `UPDATE device SET status = 'pending', credential_id = $2, public_key = $3, sign_count = $4, transports = $5, match_code = $6
     WHERE id = $1`,
    [device.id, credential.id, Buffer.from(credential.publicKey), credential.counter, (credential.transports ?? []).join(','), code],
  )
  return { status: 'pending', matchCode: code }
}

export async function requestState(db: Db, requestId: string, now = Date.now()): Promise<AccessRequestState | Refusal> {
  const device = await getDevice(db, requestId)
  const status = device ? statusOf(device, now) : 'unknown'
  if (!device || status === 'unknown') return refuse('unknown')
  return { status, matchCode: device.match_code ?? '' }
}

export async function startSignIn(db: Db, config: PasskeyConfig, deviceId: string, now = Date.now()): Promise<PasskeyGetOptions | Refusal> {
  const device = await getDevice(db, deviceId)
  const status = device ? statusOf(device, now) : 'unknown'
  if (!device?.credential_id || status !== 'approved') return refuse(status)
  return {
    rpId: config.rpId,
    challenge: await newChallenge(db, device.id, 'sign-in', now),
    allowCredentials: [device.credential_id],
    timeoutMs: CHALLENGE_TTL_MS,
  }
}

export async function finishSignIn(
  db: Db,
  config: PasskeyConfig,
  deviceId: string,
  assertion: PasskeyAssertion,
  now = Date.now(),
): Promise<Omit<Session, 'serverHasData'> | Refusal> {
  const device = await getDevice(db, deviceId)
  const status = device ? statusOf(device, now) : 'unknown'
  if (!device?.credential_id || !device.public_key || status !== 'approved') return refuse(status)
  const challenge = await takeChallenge(db, device.id, 'sign-in', now)
  if (!challenge) return { refused: 'approved', message: 'The sign-in took too long. Try again.' }
  const result = await verifyAuthenticationResponse({
    response: {
      id: String(assertion.credentialId),
      rawId: String(assertion.credentialId),
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: String(assertion.clientDataJSON),
        authenticatorData: String(assertion.authenticatorData),
        signature: String(assertion.signature),
        userHandle: assertion.userHandle === undefined ? undefined : String(assertion.userHandle),
      },
    },
    expectedChallenge: challenge,
    expectedOrigin: config.origins,
    expectedRPID: config.rpId,
    credential: {
      id: device.credential_id,
      publicKey: new Uint8Array(device.public_key),
      counter: Number(device.sign_count),
    },
    requireUserVerification: true,
  }).catch(() => ({ verified: false as const, authenticationInfo: undefined }))
  if (!result.verified || !result.authenticationInfo) {
    return { refused: 'approved', message: 'The passkey could not be verified. Try again.' }
  }
  const token = newToken()
  const expiresAt = now + SESSION_TTL_MS
  await db.query('UPDATE device SET sign_count = $2, last_seen_at = $3 WHERE id = $1', [
    device.id, result.authenticationInfo.newCounter, now,
  ])
  await db.query('DELETE FROM session WHERE device_id = $1 AND expires_at <= $2', [device.id, now])
  await db.query('INSERT INTO session (token_hash, device_id, created_at, expires_at) VALUES ($1, $2, $3, $4)', [
    sha256(token), device.id, now, expiresAt,
  ])
  return { token, expiresAt }
}

export interface Device {
  id: string
  name: string
  tokenHash: string
}

/** The approved device whose unexpired session holds this bearer token, or null. */
export async function deviceForToken(db: Db, header: string | undefined, now = Date.now()): Promise<Device | null> {
  const token = header?.match(/^Bearer (.+)$/)?.[1]
  if (!token) return null
  const tokenHash = sha256(token)
  const { rows } = await db.query<{ id: string; name: string }>(
    `UPDATE device d SET last_seen_at = $2 FROM session s
     WHERE s.token_hash = $1 AND s.device_id = d.id AND s.expires_at > $2 AND d.status = 'approved'
     RETURNING d.id, d.name`,
    [tokenHash, now],
  )
  return rows[0] ? { ...rows[0], tokenHash } : null
}

/** Of these token hashes, the ones that still belong to a live session. */
export async function liveTokenHashes(db: Db, hashes: string[], now = Date.now()): Promise<Set<string>> {
  if (hashes.length === 0) return new Set()
  const { rows } = await db.query<{ token_hash: string }>(
    `SELECT s.token_hash FROM session s JOIN device d ON d.id = s.device_id
     WHERE s.token_hash = ANY($1) AND s.expires_at > $2 AND d.status = 'approved'`,
    [hashes, now],
  )
  return new Set(rows.map((r) => r.token_hash))
}

/** Counts attempts per address within a time window, to slow down guessing and flooding. */
export class AttemptLimiter {
  private readonly attempts = new Map<string, number[]>()
  private readonly max: number
  private readonly windowMs: number

  constructor(max = 5, windowMs = 60_000) {
    this.max = max
    this.windowMs = windowMs
  }

  blocked(key: string, now = Date.now()): boolean {
    const recent = (this.attempts.get(key) ?? []).filter((t) => now - t < this.windowMs)
    this.attempts.set(key, recent)
    return recent.length >= this.max
  }

  fail(key: string, now = Date.now()): void {
    this.attempts.set(key, [...(this.attempts.get(key) ?? []), now])
  }
}

// ---------- Admin decisions (admin.ts) ----------

export interface DeviceSummary {
  id: string
  name: string
  matchCode: string
  createdAt: number
  lastSeenAt: number | null
}

const summary = (r: { id: string; name: string; match_code: string | null; created_at: string; last_seen_at: string | null }): DeviceSummary => ({
  id: r.id,
  name: r.name,
  matchCode: r.match_code ?? '',
  createdAt: Number(r.created_at),
  lastSeenAt: r.last_seen_at === null ? null : Number(r.last_seen_at),
})

export async function pendingRequests(db: Db, now = Date.now()): Promise<DeviceSummary[]> {
  const { rows } = await db.query<DeviceRow & { last_seen_at: string | null }>(
    `SELECT * FROM device WHERE status = 'pending' AND created_at > $1 ORDER BY created_at`,
    [now - REQUEST_TTL_MS],
  )
  return rows.map(summary)
}

export async function approvedDevices(db: Db): Promise<DeviceSummary[]> {
  const { rows } = await db.query<DeviceRow & { last_seen_at: string | null }>(
    `SELECT * FROM device WHERE status = 'approved' ORDER BY created_at`,
  )
  return rows.map(summary)
}

/** Approves or denies the one pending request showing this match code. */
export async function decideRequest(db: Db, code: string, decision: 'approved' | 'denied', now = Date.now()): Promise<DeviceSummary> {
  const matches = (await pendingRequests(db, now)).filter((d) => normalizeCode(d.matchCode) === normalizeCode(code))
  if (matches.length !== 1) {
    throw new Error(matches.length ? 'Several requests show that code; deny them and request again.' : `No pending request shows ${code}.`)
  }
  await db.query('UPDATE device SET status = $2, decided_at = $3 WHERE id = $1', [matches[0].id, decision, now])
  return matches[0]
}

/** Disconnects an approved device (by id or a unique prefix of it) and ends its sessions. */
export async function revokeDevice(db: Db, idPrefix: string, now = Date.now()): Promise<DeviceSummary> {
  const prefix = idPrefix.trim().toUpperCase()
  const matches = prefix ? (await approvedDevices(db)).filter((d) => d.id.startsWith(prefix)) : []
  if (matches.length !== 1) throw new Error(matches.length ? 'That prefix matches several devices.' : 'No approved device has that id.')
  await db.query(`UPDATE device SET status = 'revoked', revoked_at = $2, decided_at = $2 WHERE id = $1`, [matches[0].id, now])
  await db.query('DELETE FROM session WHERE device_id = $1', [matches[0].id])
  return matches[0]
}
