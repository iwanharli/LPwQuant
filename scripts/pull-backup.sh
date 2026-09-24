#!/usr/bin/env bash
# Pulls the newest database dump from the server to this machine and keeps the last few. Runs from the laptop, so
# the copy survives losing the VPS -- and, because it runs outside the server, it also notices when the whole
# server is unreachable, which the server's own watchdog cannot.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
set -a
# shellcheck disable=SC1091
. "$ROOT/.env"
set +a

HOST="${BACKUP_HOST:-root@217.76.51.113}"
REMOTE_DIR="${BACKUP_REMOTE_DIR:-/var/www/quant/backups}"
LOCAL_DIR="${BACKUP_LOCAL_DIR:-$HOME/Backups/quant}"
KEEP="${BACKUP_KEEP_LOCAL:-5}"

notify() {
  [[ -z "${TELEGRAM_BOT_TOKEN:-}" || -z "${TELEGRAM_CHAT_ID:-}" ]] && return 0
  curl -s --max-time 15 -o /dev/null \
    "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
    --data-urlencode "parse_mode=HTML" \
    --data-urlencode "text=$1"
}

mkdir -p "$LOCAL_DIR"

newest="$(ssh -o BatchMode=yes -o ConnectTimeout=20 "$HOST" "ls -1t $REMOTE_DIR/*.dump 2>/dev/null | head -1")"
if [[ -z "$newest" ]]; then
  notify "🔴 <b>Backup quant gagal</b>%0AServer tidak bisa dihubungi, atau tidak ada dump di $REMOTE_DIR."
  exit 1
fi

name="$(basename "$newest")"
if [[ -f "$LOCAL_DIR/$name" ]]; then
  echo "sudah ada: $name"
else
  scp -q "$HOST:$newest" "$LOCAL_DIR/$name.part" || {
    notify "🔴 <b>Backup quant gagal</b>%0AGagal menyalin $name dari server."
    exit 1
  }
  mv "$LOCAL_DIR/$name.part" "$LOCAL_DIR/$name"
  echo "tersalin: $name ($(du -h "$LOCAL_DIR/$name" | cut -f1))"
fi

# Keep only the newest few: these are ~400 MB each.
ls -1t "$LOCAL_DIR"/*.dump 2>/dev/null | tail -n +"$((KEEP + 1))" | while read -r old; do
  rm -f "$old"
  echo "dihapus: $(basename "$old")"
done

# A dump older than two days means the server's nightly backup stopped, even if everything else looks fine.
age_h=$(( ( $(date +%s) - $(stat -f %m "$LOCAL_DIR/$name" 2>/dev/null || stat -c %Y "$LOCAL_DIR/$name") ) / 3600 ))
if (( age_h > 48 )); then
  notify "⚠️ <b>Backup quant basi</b>%0ADump terbaru di server berumur ${age_h} jam."
fi
