import pg from 'pg'

// Postgres schema, applied in order. Append new migrations; never edit shipped ones.
//
// One sequence numbers every accepted change (metadata field or body update), so a device pulls everything
// after the last number it saw. Metadata is stored per field with its HLC timestamp (newest wins).

const MIGRATIONS: string[][] = [
  [
    `CREATE SEQUENCE change_seq`,
    `CREATE TABLE device (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at BIGINT NOT NULL,
      last_seen_at BIGINT,
      revoked_at BIGINT
    )`,
    `CREATE TABLE enroll_code (
      code_hash TEXT PRIMARY KEY,
      created_by TEXT,
      created_at BIGINT NOT NULL,
      expires_at BIGINT NOT NULL,
      used_at BIGINT
    )`,
    `CREATE TABLE record (
      kind TEXT NOT NULL,
      id TEXT NOT NULL,
      field TEXT NOT NULL,
      value JSONB,
      ts TEXT NOT NULL,
      seq BIGINT NOT NULL,
      device_id TEXT NOT NULL,
      PRIMARY KEY (kind, id, field)
    )`,
    `CREATE INDEX record_seq ON record (seq)`,
    `CREATE TABLE body_update (
      seq BIGINT PRIMARY KEY,
      note_id TEXT NOT NULL,
      data BYTEA NOT NULL,
      device_id TEXT NOT NULL
    )`,
    `CREATE INDEX body_update_note ON body_update (note_id)`,
    `CREATE TABLE blob (hash TEXT PRIMARY KEY, size BIGINT NOT NULL, created_at BIGINT NOT NULL)`,
  ],
  // Passkeys (docs/passkeys.md). Devices that joined with codes and bearer tokens are cut off; they request
  // access again. Status: new (passkey not yet sent), pending, approved, denied, revoked.
  [
    `ALTER TABLE device ALTER COLUMN token_hash DROP NOT NULL`,
    `ALTER TABLE device ADD COLUMN status TEXT NOT NULL DEFAULT 'revoked'`,
    `ALTER TABLE device ALTER COLUMN status DROP DEFAULT`,
    `UPDATE device SET token_hash = NULL, revoked_at = COALESCE(revoked_at, (extract(epoch FROM now()) * 1000)::bigint)`,
    `ALTER TABLE device ADD COLUMN credential_id TEXT UNIQUE`,
    `ALTER TABLE device ADD COLUMN public_key BYTEA`,
    `ALTER TABLE device ADD COLUMN sign_count BIGINT NOT NULL DEFAULT 0`,
    `ALTER TABLE device ADD COLUMN transports TEXT`,
    `ALTER TABLE device ADD COLUMN match_code TEXT`,
    `ALTER TABLE device ADD COLUMN decided_at BIGINT`,
    `DROP TABLE enroll_code`,
    `CREATE TABLE challenge (
      device_id TEXT NOT NULL,
      purpose TEXT NOT NULL,
      challenge TEXT NOT NULL,
      expires_at BIGINT NOT NULL,
      PRIMARY KEY (device_id, purpose)
    )`,
    `CREATE TABLE session (
      token_hash TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      expires_at BIGINT NOT NULL
    )`,
    `CREATE INDEX session_device ON session (device_id)`,
  ],
]

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: 5 })
}

export async function migrate(pool: pg.Pool): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)')
    const { rows } = await client.query<{ version: number }>('SELECT version FROM schema_version')
    if (rows.length === 0) await client.query('INSERT INTO schema_version (version) VALUES (0)')
    for (let version = rows[0]?.version ?? 0; version < MIGRATIONS.length; version++) {
      await client.query('BEGIN')
      for (const stmt of MIGRATIONS[version]) await client.query(stmt)
      await client.query('UPDATE schema_version SET version = $1', [version + 1])
      await client.query('COMMIT')
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/** Runs `fn` in a transaction. */
export async function transaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}
