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

**Not proxied through Cloudflare on purpose:** a proxy would decrypt all traffic, device tokens included, on Cloudflare's servers.

If the home IP changes, SSH is blocked. Use the droplet's **Recovery Console** in DigitalOcean, then update the firewall rule.

## Credentials

- No secret goes in the repo, a chat, a URL or a log. Server secrets are generated on the droplet and live in root-owned `600` files.
- `notes_droplet` is used only for this droplet. Only its `.pub` half leaves the PC.
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

## Windows: lock down the private keys

Windows OpenSSH doesn't check key permissions. Restrict each private key to your account:

```
foreach ($k in 'notes_droplet','id_ed25519','tectonic_deploy') { icacls "$HOME\.ssh\$k" /inheritance:r /grant:r "${env:USERNAME}:F" }
```
