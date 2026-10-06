#!/usr/bin/env bash
# Install or update CamVault on Red Hat Enterprise Linux 9/10 (also Rocky,
# AlmaLinux, CentOS Stream, Fedora) using Podman and systemd.
#
#   sudo ./install-rhel.sh                          # recordings in /var/lib/camvault/recordings
#   sudo RECORDINGS_DIR=/mnt/cctv ./install-rhel.sh # recordings on another disk
#
# Running it again rebuilds the app from the files in this folder and restarts
# it, keeping your cameras, password and recordings.
set -euo pipefail

PORT="${PORT:-8080}"
DATA_DIR="${DATA_DIR:-/var/lib/camvault}"
RECORDINGS_DIR="${RECORDINGS_DIR:-$DATA_DIR/recordings}"
ENV_FILE=/etc/camvault/camvault.env
UNIT_FILE=/etc/containers/systemd/camvault.container
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }

if [[ $EUID -ne 0 ]]; then
  echo "Please run with sudo:  sudo $0" >&2
  exit 1
fi
if [[ ! -f "$SRC_DIR/Dockerfile" || ! -f "$SRC_DIR/deploy/camvault.container" ]]; then
  echo "Run this script from inside the CamVault folder (where the Dockerfile is)." >&2
  exit 1
fi

say "Installing Podman"
dnf install -y podman

say "Building the CamVault image (the first build takes a few minutes)"
podman build -t localhost/camvault:latest "$SRC_DIR"

say "Creating folders"
mkdir -p "$DATA_DIR" "$RECORDINGS_DIR" /etc/camvault
echo "  App data:   $DATA_DIR"
echo "  Recordings: $RECORDINGS_DIR"

NEW_PASSWORD=""
if [[ ! -f "$ENV_FILE" ]]; then
  say "Creating settings file $ENV_FILE"
  NEW_PASSWORD="$(head -c 18 /dev/urandom | base64 | tr -d '/+=')"
  cat > "$ENV_FILE" <<CONF
# CamVault settings. After changing this file run:  sudo systemctl restart camvault

# Web login
ADMIN_USER=admin
ADMIN_PASSWORD=$NEW_PASSWORD

# Delete recordings older than this many days (0 = keep forever)
RETENTION_DAYS=14
# Maximum total size of all recordings in GB (0 = no limit)
MAX_STORAGE_GB=0
# Always keep at least this many GB free on the recordings disk
MIN_FREE_GB=5

# How long a login lasts, in hours
SESSION_HOURS=12
# Set to 1 if you put a reverse proxy (nginx, Caddy) in front of CamVault
TRUST_PROXY=0
TZ=$(timedatectl show -p Timezone --value 2>/dev/null || echo UTC)
CONF
  chmod 600 "$ENV_FILE"
else
  say "Keeping existing settings in $ENV_FILE"
fi

say "Installing the systemd service"
sed -e "s#@PORT@#$PORT#" -e "s#@DATA_DIR@#$DATA_DIR#" -e "s#@RECORDINGS_DIR@#$RECORDINGS_DIR#" \
  "$SRC_DIR/deploy/camvault.container" > "$UNIT_FILE"
systemctl daemon-reload
systemctl restart camvault.service

if systemctl is-active --quiet firewalld; then
  say "Opening port $PORT/tcp in the firewall"
  firewall-cmd --permanent --add-port="$PORT/tcp" >/dev/null
  firewall-cmd --reload >/dev/null
fi

sleep 3
if ! systemctl is-active --quiet camvault.service; then
  echo "CamVault did not start. See the log with:  sudo journalctl -u camvault -n 50" >&2
  exit 1
fi

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
say "CamVault is running"
echo "  Open:      http://${IP:-<server-ip>}:$PORT"
echo "  Username:  admin"
if [[ -n "$NEW_PASSWORD" ]]; then
  echo "  Password:  $NEW_PASSWORD"
  echo "  (Write it down. To change it, edit $ENV_FILE then: sudo systemctl restart camvault)"
else
  echo "  Password:  as set in $ENV_FILE"
fi
