import { buildApp } from './app'
import { createPool, migrate } from './db'

// Sync server entry point: npm run dev -w @tdjr/server. Devices join with passkeys and are approved with
// `npm run admin -w @tdjr/server` (admin.ts).
//
// Settings come from the environment:
//   DATABASE_URL   postgres://notes:notes@localhost:5320/notes (the docker-compose database)
//   HOST, PORT     127.0.0.1, 5319
//   BLOB_DIR       ./data/blobs
//   CORS_ORIGINS   comma-separated origins allowed to call the API (the desktop app's by default)
//   RP_ID          passkey domain: localhost, or notes.tillmanjr.com in production
//   RP_NAME        name shown in passkey prompts (Notes)
//   PASSKEY_ORIGINS  comma-separated origins passkey responses may come from: the browser dev build and the
//                  server's own origin (which native clients use)
//   TRUST_PROXY    1 behind Caddy, so rate limits see real client addresses

const env = process.env
const list = (value: string) =>
  value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
const config = {
  databaseUrl: env.DATABASE_URL ?? 'postgres://notes:notes@localhost:5320/notes',
  host: env.HOST ?? '127.0.0.1',
  port: Number(env.PORT ?? 5319),
  blobDir: env.BLOB_DIR ?? './data/blobs',
  corsOrigins: list(env.CORS_ORIGINS ?? 'http://localhost:5318,http://tauri.localhost,tauri://localhost,https://localhost'),
  passkey: {
    rpId: env.RP_ID ?? 'localhost',
    rpName: env.RP_NAME ?? 'Notes',
    origins: list(env.PASSKEY_ORIGINS ?? 'http://localhost:5318,http://localhost:5319'),
  },
  trustProxy: env.TRUST_PROXY === '1',
}

const pool = createPool(config.databaseUrl)
await migrate(pool)
const { blobDir, corsOrigins, passkey, trustProxy } = config
const app = await buildApp({ pool, blobDir, corsOrigins, passkey, trustProxy, logger: true })
await app.listen({ host: config.host, port: config.port })
const { rowCount } = await pool.query(`SELECT 1 FROM device WHERE status = 'approved' LIMIT 1`)
if (!rowCount) {
  console.log(
    [
      '',
      '  No approved devices yet. Request access from the app (⚙ → Request access…), then approve it with:',
      '    npm run admin -w @tdjr/server -- pending',
      '',
    ].join('\n'),
  )
}
