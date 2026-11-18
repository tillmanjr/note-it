import { createHash, randomBytes, randomInt } from 'node:crypto'
import type pg from 'pg'

// Devices authenticate with long-lived bearer tokens; only their SHA-256 is stored. New devices join with a
// short one-time code: printed by the server for the first device, or shown by an already-connected device.

/** Unambiguous characters (no 0/O, 1/I/L) so codes are easy to read and type. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
export const DEVICE_CODE_TTL_MS = 10 * 60_000
export const SETUP_CODE_TTL_MS = 24 * 60 * 60_000

export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

export const newToken = () => randomBytes(32).toString('base64url')

/** Normalizes what the user typed: case, spaces and dashes don't matter. */
export const normalizeCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '')

/** Creates a one-time enrollment code like "K7QM-2XPA". */
export async function createEnrollCode(
  db: pg.Pool | pg.PoolClient,
  opts: { createdBy?: string | null; ttlMs: number; now?: number },
): Promise<{ code: string; expiresAt: number }> {
  const raw = Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('')
  const now = opts.now ?? Date.now()
  const expiresAt = now + opts.ttlMs
  await db.query('INSERT INTO enroll_code (code_hash, created_by, created_at, expires_at) VALUES ($1, $2, $3, $4)', [
    sha256(raw), opts.createdBy ?? null, now, expiresAt,
  ])
  return { code: `${raw.slice(0, 4)}-${raw.slice(4)}`, expiresAt }
}

export interface Device {
  id: string
  name: string
}

/** The device holding this bearer token, or null if it's unknown or revoked. */
export async function deviceForToken(db: pg.Pool, header: string | undefined): Promise<Device | null> {
  const token = header?.match(/^Bearer (.+)$/)?.[1]
  if (!token) return null
  const { rows } = await db.query<Device>(
    'UPDATE device SET last_seen_at = $2 WHERE token_hash = $1 AND revoked_at IS NULL RETURNING id, name',
    [sha256(token), Date.now()],
  )
  return rows[0] ?? null
}

/** Counts failed code attempts per address, to slow down guessing. */
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
