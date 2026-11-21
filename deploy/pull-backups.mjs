// Copies the droplet's encrypted nightly backups to this PC (docs/deploy.md): `npm run backup:pull`.
// Fetches only the files not here yet, into NOTES_BACKUP_DIR (default ~/notes-backups, outside the repo).
// They stay encrypted; restoring needs the age private key. Uses the notes_droplet SSH key.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const HOST = 'tillman@notes.tillmanjr.com'
const REMOTE = '/var/backups/notes'
const key = join(homedir(), '.ssh', 'notes_droplet')
const dest = process.env.NOTES_BACKUP_DIR ?? join(homedir(), 'notes-backups')
const ssh = ['-i', key, '-o', 'IdentitiesOnly=yes']

const run = (cmd, args, input) => {
  const r = spawnSync(cmd, args, { input, encoding: 'utf8', stdio: [input === undefined ? 'inherit' : 'pipe', 'pipe', 'inherit'] })
  if (r.status !== 0) {
    console.error(`${cmd} failed (exit ${r.status ?? r.signal}).`)
    process.exit(1)
  }
  return r.stdout
}

mkdirSync(dest, { recursive: true })
const remote = run('ssh', [...ssh, HOST, `ls -1 ${REMOTE}`])
  .split('\n')
  .map((s) => s.trim())
  // Only finished backups with the expected names, so a listing can't smuggle in anything else.
  .filter((name) => /^notes-(db|blobs)-\d{4}-\d{2}-\d{2}_\d{4}\.(dump|tar)\.age$/.test(name))
const local = new Set(existsSync(dest) ? readdirSync(dest) : [])
const missing = remote.filter((name) => !local.has(name))

if (!missing.length) {
  console.log(`Up to date: ${remote.length} backups on the droplet, all already in ${dest}.`)
} else {
  const batch = missing.map((name) => `get ${REMOTE}/${name} "${join(dest, name).replace(/\\/g, '/')}"`).join('\n') + '\n'
  run('sftp', [...ssh, '-q', '-b', '-', HOST], batch)
  console.log(`Copied ${missing.length} new backup file(s) to ${dest}.`)
}
