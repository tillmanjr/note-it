#!/usr/bin/env bash
# Installs the sync server's services on the hardened droplet (after 01-harden.sh). Run once with sudo from a
# copy of the deploy/ folder:
#   sudo bash 02-install.sh <age public key> [ACME email]
# The age public key (age1…) encrypts the nightly backups; its private half stays on the PC. Safe to run again.
# Holds no secrets: the database uses peer authentication over its socket, so there is no password to generate.
set -euo pipefail

RECIPIENT=${1:-}
ACME_EMAIL=${2:-}
HERE=$(cd "$(dirname "$0")" && pwd)
FILES=$HERE/files
NODE_MAJOR=24

step() { printf '\n== %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run with sudo"
grep -q 'VERSION_ID="24.04"' /etc/os-release || die "expected Ubuntu 24.04"
id tillman >/dev/null 2>&1 || die "run 01-harden.sh first"
[[ $RECIPIENT =~ ^age1[0-9a-z]{58}$ ]] || die "usage: sudo bash 02-install.sh <age public key, age1…> [ACME email]"
[[ -z $ACME_EMAIL || $ACME_EMAIL =~ ^[^@[:space:]]+@[^@[:space:]]+$ ]] || die "not an email address: $ACME_EMAIL"
[[ -f $FILES/notes-server.service ]] || die "run from the copied deploy/ folder (files/ is missing)"

export DEBIAN_FRONTEND=noninteractive

step "Package sources: NodeSource (Node.js $NODE_MAJOR) and Caddy"
apt-get update -q
apt-get -y -q install ca-certificates curl gnupg
install -d -m 755 /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
  > /etc/apt/sources.list.d/nodesource.list
curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/caddy-stable.gpg
echo "deb [signed-by=/etc/apt/keyrings/caddy-stable.gpg] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main" \
  > /etc/apt/sources.list.d/caddy-stable.list
# Let automatic updates patch these too, not just Ubuntu's own packages.
cat > /etc/apt/apt.conf.d/53notes-origins <<'EOF'
Unattended-Upgrade::Origins-Pattern {
  "site=deb.nodesource.com";
  "site=dl.cloudsmith.io";
};
EOF

step "Packages: Node.js, PostgreSQL 16, Caddy, age, jq"
apt-get update -q
apt-get -y -q install nodejs postgresql caddy age jq
node --version

step "The notes user and its directories"
id notes >/dev/null 2>&1 || useradd --system --home-dir /var/lib/notes --shell /usr/sbin/nologin notes
install -d -m 750 -o notes -g notes /var/lib/notes
install -d -m 700 -o notes -g notes /var/lib/notes/blobs
install -d -m 755 /opt/notes /opt/notes/releases
install -d -m 750 /etc/notes
install -m 600 "$FILES/notes.env" /etc/notes/env
echo "$RECIPIENT" > /etc/notes/backup-recipient.txt
chmod 644 /etc/notes/backup-recipient.txt
install -d -m 750 -o root -g tillman /var/backups/notes

step "Database (peer authentication: only the notes OS user can connect as notes)"
systemctl enable --now postgresql
runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_roles WHERE rolname = 'notes'" | grep -q 1 ||
  runuser -u postgres -- createuser --no-superuser --no-createdb --no-createrole notes
runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_database WHERE datname = 'notes'" | grep -q 1 ||
  runuser -u postgres -- createdb --owner=notes notes

step "Commands and services"
install -m 755 "$FILES/notes-deploy" "$FILES/notes-admin" "$FILES/notes-backup" /usr/local/sbin/
install -m 644 "$FILES/notes-server.service" "$FILES/notes-backup.service" "$FILES/notes-backup.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable notes-server
systemctl enable --now notes-backup.timer

step "Caddy (TLS for notes.tillmanjr.com)"
{
  if [[ -n $ACME_EMAIL ]]; then printf '{\n\temail %s\n}\n\n' "$ACME_EMAIL"; fi
  cat "$FILES/Caddyfile"
} > /etc/caddy/Caddyfile
install -d -m 755 -o caddy -g caddy /var/log/caddy
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl enable caddy
systemctl reload-or-restart caddy

step "Done"
cat <<'EOF'
Next: install the newest release and check it.
  sudo notes-deploy
  curl -s https://notes.tillmanjr.com/health
Then request access from the app with https://notes.tillmanjr.com and approve it here:
  sudo notes-admin pending
  sudo notes-admin approve <CODE>
EOF
