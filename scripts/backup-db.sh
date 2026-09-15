#!/usr/bin/env bash
# Daily Postgres backup for db_quant. Keeps the newest $BACKUP_KEEP dumps (default 14).
# Restore: pg_restore --clean --if-exists -d db_quant backups/<file>.dump
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -f "$ROOT/.env" ]]; then
  # Only DATABASE_URL is needed here; avoid exporting every secret into this shell.
  DATABASE_URL="$(grep -E '^DATABASE_URL=' "$ROOT/.env" | tail -1 | cut -d= -f2- || true)"
fi
DATABASE_URL="${DATABASE_URL:-postgres://localhost:5432/db_quant}"
BACKUP_DIR="${BACKUP_DIR:-$ROOT/backups}"
BACKUP_KEEP="${BACKUP_KEEP:-14}"

mkdir -p "$BACKUP_DIR"
stamp="$(TZ=Asia/Jakarta date +%Y%m%d-%H%M)"
target="$BACKUP_DIR/db_quant-$stamp.dump"
tmp="$target.partial"

echo "[backup] $(TZ=Asia/Jakarta date '+%F %T') WIB dumping to $target"
pg_dump --format=custom --compress=6 --no-owner --file="$tmp" "$DATABASE_URL"
mv "$tmp" "$target"
echo "[backup] done: $(du -h "$target" | cut -f1)"

# Rotate: delete everything but the newest $BACKUP_KEEP dumps.
ls -1t "$BACKUP_DIR"/db_quant-*.dump 2>/dev/null | tail -n +"$((BACKUP_KEEP + 1))" | while read -r old; do
  echo "[backup] removing old $old"
  rm -f -- "$old"
done
