// Copies the droplet's encrypted nightly backups to this PC (docs/deploy.md): `npm run backup:pull`.
// Fetches only the files not here yet, into NOTES_BACKUP_DIR (default ~/notes-backups, outside the repo).
// They stay encrypted; restoring needs the age private key. Uses the notes_droplet SSH key.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const HOST = 'tillman@notes.tillmanjr.com'
const REMOTE = '/var/backups/notes'
const key = join(homedir(), '.ssh', 'notes_droplet')
const dest = process.env.NOTES_BACKUP_DIR ?? join(homedir(), 'notes-backups')
const ssh = ['-i', key, '-o', 'IdentitiesOnly=yes']
// Windows' own tar (bsdtar); a GNU tar from Git's tools would read C:\… as a remote host.
const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar'

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
  // One SSH connection streams the missing files as a tar, which Windows' built-in tar unpacks. (sftp's batch
  // mode would refuse to ask for the key's passphrase.)
  const pack = spawn('ssh', [...ssh, HOST, `tar -C ${REMOTE} -cf - ${missing.join(' ')}`], { stdio: ['inherit', 'pipe', 'inherit'] })
  const unpack = spawn(tar, ['-xf', '-', '-C', dest], { stdio: ['pipe', 'inherit', 'inherit'] })
  pack.stdout.pipe(unpack.stdin)
  const exit = (p) => new Promise((resolve) => p.on('close', resolve))
  const [packed, unpacked] = await Promise.all([exit(pack), exit(unpack)])
  if (packed !== 0 || unpacked !== 0) {
    console.error(`Copy failed (ssh exit ${packed}, tar exit ${unpacked}).`)
    process.exit(1)
  }
  console.log(`Copied ${missing.length} new backup file(s) to ${dest}.`)
}
