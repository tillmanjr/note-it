import { createPool, migrate } from './db'
import { approvedDevices, decideRequest, pendingRequests, revokeDevice } from './passkey'

// Device administration. Run on the server, never from the app (docs/passkeys.md):
//   npm run admin -w @tdjr/server -- pending          requests waiting for approval, with their match codes
//   npm run admin -w @tdjr/server -- approve K7F-2QM  approve the request showing this code on the device
//   npm run admin -w @tdjr/server -- deny K7F-2QM
//   npm run admin -w @tdjr/server -- devices          approved devices
//   npm run admin -w @tdjr/server -- revoke <id>      disconnect a device (an id from `devices`; a unique prefix works)
// Uses DATABASE_URL like the server.

const USAGE = 'usage: admin pending | approve <code> | deny <code> | devices | revoke <device id>'

const pool = createPool(process.env.DATABASE_URL ?? 'postgres://notes:notes@localhost:5320/notes')
const [command, arg] = process.argv.slice(2)
const when = (ms: number | null) => (ms === null ? 'never' : new Date(ms).toLocaleString())

async function main() {
  await migrate(pool)
  switch (command) {
    case 'pending': {
      const rows = await pendingRequests(pool)
      if (!rows.length) return console.log('No requests are waiting.')
      for (const r of rows) console.log(`${r.matchCode}  ${r.name.padEnd(30)}  requested ${when(r.createdAt)}`)
      return
    }
    case 'approve':
    case 'deny': {
      if (!arg) throw new Error(USAGE)
      const d = await decideRequest(pool, arg, command === 'approve' ? 'approved' : 'denied')
      return console.log(`${command === 'approve' ? 'Approved' : 'Denied'} "${d.name}" (${d.id}).`)
    }
    case 'devices': {
      const rows = await approvedDevices(pool)
      if (!rows.length) return console.log('No approved devices.')
      for (const r of rows) console.log(`${r.id}  ${r.name.padEnd(30)}  last seen ${when(r.lastSeenAt)}`)
      return
    }
    case 'revoke': {
      if (!arg) throw new Error(USAGE)
      const d = await revokeDevice(pool, arg)
      return console.log(`Revoked "${d.name}" (${d.id}). Its open connections close within 15 seconds.`)
    }
    default:
      throw new Error(USAGE)
  }
}

try {
  await main()
} catch (err) {
  console.error((err as Error).message)
  process.exitCode = 1
} finally {
  await pool.end()
}
