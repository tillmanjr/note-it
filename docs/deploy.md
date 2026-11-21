# Deploy

The sync server's droplet. Spec in [recommended-droplet.md](recommended-droplet.md); how sync works in [sync.md](sync.md).

## The droplet (created 2026-11-20)

| | |
|---|---|
| Hostname | `tdjr-notes` (Ubuntu 24.04, own DigitalOcean project) |
| Domain | `notes.tillmanjr.com`, Cloudflare DNS-only: A → reserved IP `178.128.130.174`, AAAA → `2604:a880:2:d1:0:1:dd46:1`, CAA `0 issue "letsencrypt.org"` |
| Droplet IPv4 | `157.245.182.246` (DNS uses the reserved IP, not this) |
| Host key | ED25519 `SHA256:zebMeWHHZMnPMK2fqB4qKuz/iMzqKnHKtS2WpbyI4S8` |
| Backups | DigitalOcean nightly, midnight–4:00 Pacific |
| Cloud firewall | inbound 22 from the home IP only; 80 and 443 from anywhere |
| Login | `ssh -i ~/.ssh/notes_droplet tillman@notes.tillmanjr.com` (after hardening) |

**Not proxied through Cloudflare on purpose:** a proxy would decrypt all traffic, session tokens included, on Cloudflare's servers.

If the home IP changes, SSH is blocked. Use the droplet's **Recovery Console** in DigitalOcean, then update the firewall rule.

## Server decisions (2026-11-20)

| Area | Decision |
|---|---|
| Runtime | Native services, no Docker: PostgreSQL 16 (Ubuntu), Caddy (its official apt repo), Node.js 24 (NodeSource), and the sync server as the systemd service `notes-server`. Automatic updates cover all three repos. |
| Releases | Pushing a tag `server-vX.Y.Z` runs the **Server release** workflow, which tests against Postgres 16, bundles the server into two files (`main.mjs`, `admin.mjs`) and attaches them to a GitHub Release with a SHA-256 file. The droplet **pulls**: `sudo notes-deploy` downloads, checks the hash (and GitHub's digest), switches over and rolls back if `/health` doesn't report the new version. No credential exists for this anywhere: the repo is public and SSH stays limited to the home IP. |
| Database | Peer authentication over the Unix socket: only the `notes` OS user connects as `notes`. No database password exists. |
| Server secrets | None. Session tokens are random per device and stored only as hashes; `/etc/notes/env` holds plain settings (root, `600`). |
| TLS | Caddy with Let's Encrypt (the CAA record allows only it). Logs redact the Authorization header. |
| Sandbox | `notes-server` runs as `notes`, can write only `/var/lib/notes`, and has no capabilities (see the unit file). |
| Backups | `notes-backup.timer` at 23:15 Pacific, before DigitalOcean's backup window: a database dump and a tar of the attachments, each encrypted with **age** to a public key. Only the PC has the private key. The newest 14 of each stay in `/var/backups/notes`; `npm run backup:pull` copies new ones to `~/notes-backups`. |

## Credentials

- No secret goes in the repo, a chat, a URL or a log. Server secrets are generated on the droplet and live in root-owned `600` files.
- `notes_droplet` is used only for this droplet. Only its `.pub` half leaves the PC.
- **Leak scanning:** a gitleaks pre-commit hook (`.githooks/`, switched on by `npm install`) blocks commits with secrets, and the Secret scan workflow checks the full history on every push and PR. gitleaks must be installed locally (`winget install Gitleaks.Gitleaks`) or the hook refuses to commit. `apps/server/.env.example` lists the server's settings by name only.
- The sudo password for `tillman` is set on the droplet and kept in a password manager. SSH never accepts passwords.

## 1. Harden (once)

From PowerShell in the repo, using the key the droplet was created with:

```
scp -i ~/.ssh/id_ed25519 deploy/01-harden.sh $HOME/.ssh/notes_droplet.pub root@notes.tillmanjr.com:
ssh -i ~/.ssh/id_ed25519 root@notes.tillmanjr.com
bash 01-harden.sh notes_droplet.pub
```

[`deploy/01-harden.sh`](../deploy/01-harden.sh) installs updates and automatic security updates (rebooting at 04:30 when needed, after the backup window). It also creates `tillman` with sudo and the `notes_droplet` key, turns off root and password login, empties root's keys, and sets up fail2ban, ufw (22 rate-limited, 80, 443), 2 GB swap and Pacific time.

**Keep the root session open** and test `ssh -i ~/.ssh/notes_droplet tillman@notes.tillmanjr.com` in a new window. Then run `sudo whoami` there, which should print `root`. Only close the root session once both work. Run `sudo reboot` if the script says a reboot is pending.

## 2. Backup key (once, on the PC)

```
winget install FiloSottile.age
age-keygen -o $HOME\.ssh\notes_backup.age
icacls "$HOME\.ssh\notes_backup.age" /inheritance:r /grant:r "${env:USERNAME}:F"
```

Also save the key file's contents in your password manager. Without the key, no backup can be restored. `age-keygen` prints the **public key** (`age1…`), which isn't secret and is used in step 4. `age-keygen -y $HOME\.ssh\notes_backup.age` prints it again.

## 3. First release

Bump `version` in `apps/server/package.json`, merge to `main`, then tag that commit:

```
git tag server-v0.1.0
git push origin server-v0.1.0
```

Wait for the **Server release** workflow to finish (Actions tab). Later releases work the same way: bump, merge, tag.

## 4. Install the services (once)

```
scp -i ~/.ssh/notes_droplet -r deploy tillman@notes.tillmanjr.com:
ssh -i ~/.ssh/notes_droplet tillman@notes.tillmanjr.com
sudo bash deploy/02-install.sh <age public key> [email for Let's Encrypt notices]
sudo notes-deploy
curl -s https://notes.tillmanjr.com/health
```

[`deploy/02-install.sh`](../deploy/02-install.sh) installs the package repos and packages, the `notes` user and its directories, the database, the commands `notes-deploy`, `notes-admin` and `notes-backup`, the services and Caddy. It's safe to run again after changing anything under `deploy/files/`.

## Day to day

- **New release:** after the workflow finishes, run `sudo notes-deploy` on the droplet. `sudo notes-deploy server-v0.1.0` installs or rolls back to a specific release.
- **Approve a device:** in the app, use ⚙ → Request access… with `https://notes.tillmanjr.com`. Then on the droplet run `sudo notes-admin pending`, and `sudo notes-admin approve <CODE>` if the code matches the one the app shows. `sudo notes-admin devices` lists devices and `sudo notes-admin revoke <id>` disconnects one.
- **Logs:** `journalctl -u notes-server -f` for the server and `/var/log/caddy/notes.log` for requests.
- **Backups to the PC:** `npm run backup:pull`. The files stay encrypted.

## Restore

On the PC, decrypt with the backup key. Never copy the key to the droplet:

```
age -d -i $HOME\.ssh\notes_backup.age -o notes.dump notes-db-<stamp>.dump.age
age -d -i $HOME\.ssh\notes_backup.age -o blobs.tar notes-blobs-<stamp>.tar.age
```

Copy both to the droplet, then:

```
sudo systemctl stop notes-server
sudo -u postgres pg_restore --clean --if-exists --no-owner --role=notes -d notes notes.dump
sudo tar -C /var/lib/notes -xf blobs.tar && sudo chown -R notes:notes /var/lib/notes/blobs
sudo systemctl start notes-server
shred -u notes.dump blobs.tar
```

## Windows: lock down the private keys

Windows OpenSSH doesn't check key permissions. Restrict each private key to your account:

```
foreach ($k in 'notes_droplet','id_ed25519','tectonic_deploy') { icacls "$HOME\.ssh\$k" /inheritance:r /grant:r "${env:USERNAME}:F" }
```
