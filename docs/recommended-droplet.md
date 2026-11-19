# Recommended droplet

The DigitalOcean droplet for the sync server (milestone 2c). Recommended on 2026-11-18. Prices are from then, so check them on the create page.

**Sizing basis:** about 10 MB of attachments and a 2 MB database for one user. The smallest droplet is plenty, and a separate storage volume isn't needed yet.

## Create it with these settings

| Setting | Choose | Why |
|---|---|---|
| Region | The one closest to you | Lower sync latency. Nothing else depends on it. |
| Image | **Ubuntu 24.04 LTS x64** | Long-term support until 2029. |
| Plan | **Basic → Regular SSD → 1 vCPU / 1 GB RAM / 25 GB disk** (about $6/mo) | Enough for one user running Node and Postgres, with a 2 GB swap file and Postgres tuned for small memory. Fits the design budget of roughly $10/mo or less. |
| Volume | None for now | 25 GB is about 2,000 times the current data. Attachments can move to a volume later. |
| Authentication | **SSH key only** (no password) | Add your public key, e.g. `~/.ssh/id_ed25519.pub`. |
| Backups | **Weekly backups on** (about +20%, roughly $1.20/mo) | A safety net for the whole machine. Nightly database dumps stored off the droplet come on top. |
| Monitoring | On (free) | CPU, memory and disk graphs and alerts. |
| IPv6 | On (free) | |
| Hostname | e.g. `tdjr-notes` | |

## Right after creating it

1. **Reserve an IP address** (Networking → Reserved IPs) and assign it to the droplet. It's free while assigned, and the droplet can be rebuilt without changing DNS.
2. **Create a cloud firewall** (Networking → Firewalls):
   - inbound 22 (SSH), ideally only from your home IP;
   - inbound 80 and 443 from anywhere, for HTTPS and certificate renewal;
   - nothing else. The sync server (5319) and Postgres (5320) are reached only from the droplet itself, never from outside.
3. **Pick the domain now.** Passkeys (2c-2) are permanently tied to the domain they're created on, so choose the name you'll keep, e.g. `notes.yourdomain.com`. DNS can wait: later it gets an A record (and AAAA for IPv6) pointing at the reserved IP.
4. **Don't install anything on it yet.** Deployment comes with a setup script, written once passkeys work locally.

## What the setup script will cover

- Swap (2 GB) and Postgres settings for 1 GB of RAM.
- The sync server and Postgres, as Docker containers or native services.
- Caddy in front for HTTPS (Let's Encrypt certificates, automatic renewal), passing requests to the sync server on `127.0.0.1:5319`.
- Nightly database dumps, plus the attachment files, copied off the droplet.
- Automatic security updates.

See [sync.md](sync.md) for how sync works and [STATUS.md](STATUS.md) for where deployment sits in the plan.
