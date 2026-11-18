import { buildApp } from './app'
import { SETUP_CODE_TTL_MS, createEnrollCode } from './auth'
import { createPool, migrate } from './db'

// Sync server entry point.
//   npm run dev -w @tdjr/server          start (prints a setup code while no device is connected)
//   npm run setup-code -w @tdjr/server   print a fresh setup code, e.g. after losing every device
//
// Settings come from the environment:
//   DATABASE_URL   postgres://notes:notes@localhost:55432/notes (the docker-compose database)
//   HOST, PORT     127.0.0.1, 8787
//   BLOB_DIR       ./data/blobs
//   CORS_ORIGINS   comma-separated origins allowed to call the API (the desktop app's by default)

const env = process.env
const config = {
  databaseUrl: env.DATABASE_URL ?? 'postgres://notes:notes@localhost:55432/notes',
  host: env.HOST ?? '127.0.0.1',
  port: Number(env.PORT ?? 8787),
  blobDir: env.BLOB_DIR ?? './data/blobs',
  corsOrigins: (env.CORS_ORIGINS ?? 'http://localhost:5318,http://tauri.localhost,tauri://localhost')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
}

function printSetupCode(code: string, expiresAt: number) {
  console.log(
    [
      '',
      '  ┌──────────────────────────────────────────────┐',
      `  │  Setup code: ${code}                       │`,
      '  │  In the app: ⚙ → Connect to server…          │',
      `  │  Expires ${new Date(expiresAt).toLocaleString().padEnd(36)}│`,
      '  └──────────────────────────────────────────────┘',
      '',
    ].join('\n'),
  )
}

const pool = createPool(config.databaseUrl)
await migrate(pool)

if (process.argv.includes('--setup-code')) {
  const { code, expiresAt } = await createEnrollCode(pool, { ttlMs: SETUP_CODE_TTL_MS })
  printSetupCode(code, expiresAt)
  await pool.end()
} else {
  const app = await buildApp({ pool, blobDir: config.blobDir, corsOrigins: config.corsOrigins, logger: true })
  await app.listen({ host: config.host, port: config.port })
  const { rowCount } = await pool.query('SELECT 1 FROM device WHERE revoked_at IS NULL LIMIT 1')
  if (!rowCount) {
    const { code, expiresAt } = await createEnrollCode(pool, { ttlMs: SETUP_CODE_TTL_MS })
    printSetupCode(code, expiresAt)
  }
}
