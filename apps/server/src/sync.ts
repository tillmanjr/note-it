import type pg from 'pg'
import { SYNC_FIELDS, type BodyUpdate, type RecordChange, type RecordKind, type SyncRequest, type SyncResponse } from '@tdjr/core'
import { transaction } from './db'

/** Rows of each kind returned per pull; the client pulls again while `hasMore`. */
const PULL_LIMIT = 1000
/** Serializes pushes, so changes become visible in sequence order and no puller skips one. */
const SYNC_LOCK = 7_420_001

export class BadRequest extends Error {}

const isKind = (k: unknown): k is RecordKind => typeof k === 'string' && k in SYNC_FIELDS

function validate(req: SyncRequest): void {
  if (!Number.isSafeInteger(req.since) || req.since < 0) throw new BadRequest('since must be a non-negative integer.')
  if (!Array.isArray(req.records) || !Array.isArray(req.updates)) throw new BadRequest('records and updates must be arrays.')
  for (const r of req.records) {
    if (!isKind(r.kind) || !SYNC_FIELDS[r.kind].includes(r.field) || typeof r.id !== 'string' || typeof r.ts !== 'string') {
      throw new BadRequest(`Unknown record field ${String(r.kind)}.${String(r.field)}.`)
    }
  }
  for (const u of req.updates) {
    if (typeof u.noteId !== 'string' || typeof u.data !== 'string') throw new BadRequest('Each update needs noteId and data.')
  }
}

/** Applies a device's changes and returns everything other devices changed since its cursor. */
export async function sync(pool: pg.Pool, deviceId: string, req: SyncRequest): Promise<{ res: SyncResponse; accepted: number }> {
  validate(req)
  return transaction(pool, async (db) => {
    await db.query('SELECT pg_advisory_xact_lock($1)', [SYNC_LOCK])
    let accepted = 0

    for (const r of req.records) {
      // Newest timestamp wins; an older change is dropped (the client will pull the newer value).
      const { rowCount } = await db.query(
        `INSERT INTO record (kind, id, field, value, ts, seq, device_id)
         VALUES ($1, $2, $3, $4::jsonb, $5, nextval('change_seq'), $6)
         ON CONFLICT (kind, id, field) DO UPDATE
           SET value = excluded.value, ts = excluded.ts, seq = excluded.seq, device_id = excluded.device_id
           WHERE record.ts < excluded.ts`,
        [r.kind, r.id, r.field, JSON.stringify(r.value ?? null), r.ts, deviceId],
      )
      accepted += rowCount ?? 0
      // A note deleted forever needs no history.
      if (rowCount && r.kind === 'note' && r.field === 'purged' && r.value === true) {
        await db.query('DELETE FROM body_update WHERE note_id = $1', [r.id])
      }
    }

    for (const u of req.updates) {
      const purged = await db.query(
        `SELECT 1 FROM record WHERE kind = 'note' AND id = $1 AND field = 'purged' AND value = 'true'::jsonb`,
        [u.noteId],
      )
      if (purged.rowCount) continue
      await db.query(
        `INSERT INTO body_update (seq, note_id, data, device_id) VALUES (nextval('change_seq'), $1, $2, $3)`,
        [u.noteId, Buffer.from(u.data, 'base64'), deviceId],
      )
      accepted++
    }

    const records = await db.query<{ kind: RecordKind; id: string; field: string; value: unknown; ts: string; seq: string }>(
      `SELECT kind, id, field, value, ts, seq FROM record WHERE seq > $1 AND device_id <> $2 ORDER BY seq LIMIT $3`,
      [req.since, deviceId, PULL_LIMIT],
    )
    const updates = await db.query<{ note_id: string; data: Buffer; seq: string }>(
      `SELECT note_id, data, seq FROM body_update WHERE seq > $1 AND device_id <> $2 ORDER BY seq LIMIT $3`,
      [req.since, deviceId, PULL_LIMIT],
    )
    // A full page may have more behind it: stop at the lower of the two page ends so nothing is skipped.
    const ends = [records, updates].filter((r) => r.rows.length === PULL_LIMIT).map((r) => Number(r.rows[r.rows.length - 1].seq))
    const frontier = ends.length ? Math.min(...ends) : null
    const within = (seq: string) => frontier === null || Number(seq) <= frontier
    let cursor = frontier
    if (cursor === null) {
      const { rows } = await db.query<{ max: string | null }>(
        `SELECT GREATEST((SELECT MAX(seq) FROM record), (SELECT MAX(seq) FROM body_update)) AS max`,
      )
      cursor = Math.max(req.since, Number(rows[0].max ?? 0))
    }

    const res: SyncResponse = {
      cursor,
      hasMore: frontier !== null,
      records: records.rows
        .filter((r) => within(r.seq))
        .map((r): RecordChange => ({ kind: r.kind, id: r.id, field: r.field, value: r.value, ts: r.ts })),
      updates: updates.rows
        .filter((u) => within(u.seq))
        .map((u): BodyUpdate => ({ noteId: u.note_id, data: u.data.toString('base64') })),
    }
    return { res, accepted }
  })
}

/** Whether the server holds any notes yet. */
export async function hasNotes(pool: pg.Pool): Promise<boolean> {
  const { rowCount } = await pool.query(`SELECT 1 FROM record WHERE kind = 'note' LIMIT 1`)
  return (rowCount ?? 0) > 0
}
