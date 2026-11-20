#!/usr/bin/env bash
# First-run hardening for the notes droplet (Ubuntu 24.04). Run once as root:
#   bash 01-harden.sh notes_droplet.pub
# Safe to run again. Holds no secrets; the sudo password is typed on the droplet.
set -euo pipefail

USERNAME=tillman
TIMEZONE=America/Los_Angeles
SWAP_SIZE=2G
PUBKEY_FILE=${1:-}

step() { printf '\n== %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run as root"
grep -q 'VERSION_ID="24.04"' /etc/os-release || die "expected Ubuntu 24.04"
[[ -n $PUBKEY_FILE && -f $PUBKEY_FILE ]] || die "usage: bash 01-harden.sh <public key file>"
# Guard against copying the private half by mistake.
grep -q 'PRIVATE KEY' "$PUBKEY_FILE" && die "$PUBKEY_FILE is a private key; use the .pub file"
PUBKEY=$(head -n1 "$PUBKEY_FILE")
[[ $PUBKEY == ssh-ed25519\ * ]] || die "$PUBKEY_FILE is not an ed25519 public key"

step "Updates"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get -y -q -o Dpkg::Options::=--force-confold upgrade
apt-get -y -q install unattended-upgrades fail2ban python3-systemd ufw

step "Automatic security updates (reboot at 04:30 if needed, after the backup window)"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
cat > /etc/apt/apt.conf.d/52notes-unattended <<'EOF'
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:30";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
EOF

step "Timezone $TIMEZONE"
timedatectl set-timezone "$TIMEZONE"

step "User $USERNAME"
if ! id "$USERNAME" &>/dev/null; then
  adduser --disabled-password --gecos "" "$USERNAME"
fi
usermod -aG sudo "$USERNAME"
install -d -m 700 -o "$USERNAME" -g "$USERNAME" "/home/$USERNAME/.ssh"
printf '%s\n' "$PUBKEY" > "/home/$USERNAME/.ssh/authorized_keys"
chown "$USERNAME:$USERNAME" "/home/$USERNAME/.ssh/authorized_keys"
chmod 600 "/home/$USERNAME/.ssh/authorized_keys"
if passwd -S "$USERNAME" | grep -q ' L '; then
  echo "Choose a sudo password for $USERNAME (SSH never accepts it; keep it in your password manager):"
  passwd "$USERNAME"
fi

step "SSH: key-only, $USERNAME only, no root"
# 00- sorts before cloud-init's 50- file; sshd keeps the first value it reads.
cat > /etc/ssh/sshd_config.d/00-notes-hardening.conf <<EOF
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AuthenticationMethods publickey
AllowUsers $USERNAME
MaxAuthTries 3
LoginGraceTime 30
X11Forwarding no
AllowAgentForwarding no
EOF
sshd -t || die "sshd config invalid; nothing restarted"
# Root's key (the shared id_ed25519) no longer opens this machine.
: > /root/.ssh/authorized_keys
systemctl restart ssh

step "fail2ban (sshd jail)"
cat > /etc/fail2ban/jail.d/sshd.local <<'EOF'
[sshd]
enabled = true
backend = systemd
maxretry = 5
findtime = 10m
bantime = 1h
EOF
systemctl enable --now fail2ban
systemctl restart fail2ban

step "ufw (matches the DigitalOcean firewall)"
ufw default deny incoming
ufw default allow outgoing
ufw limit 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

step "Swap $SWAP_SIZE"
if ! swapon --show | grep -q /swapfile; then
  fallocate -l "$SWAP_SIZE" /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
echo 'vm.swappiness=10' > /etc/sysctl.d/99-notes-swap.conf
sysctl -q -p /etc/sysctl.d/99-notes-swap.conf

step "Done"
echo "Keep this session open. In a NEW window, check:  ssh -i ~/.ssh/notes_droplet $USERNAME@notes.tillmanjr.com"
[[ -f /var/run/reboot-required ]] && echo "A reboot is pending; after the check works, run:  sudo reboot"
exit 0
