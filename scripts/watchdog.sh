#!/usr/bin/env bash
# Checks the three things that must be true for this system to be collecting data, and sends one Telegram message
# when that changes -- not every run. Meant for a systemd timer on the server.
#
#   1. the engine answers /api/health
#   2. the dashboard answers
#   3. the ingestor is still writing pool snapshots (data can go stale while the process looks alive)
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
set -a
# shellcheck disable=SC1091
. "$ROOT/.env"
set +a

STATE="${WATCHDOG_STATE:-/var/tmp/quant-watchdog.state}"
ENGINE="${ENGINE_URL:-http://127.0.0.1:8000}"
DASHBOARD="http://127.0.0.1:${DASHBOARD_PORT:-3000}"
MAX_SNAPSHOT_AGE_S="${WATCHDOG_MAX_SNAPSHOT_AGE_S:-900}"

problems=()

curl -sf --max-time 10 "$ENGINE/api/health" >/dev/null || problems+=("engine tidak menjawab")
curl -sf --max-time 15 -o /dev/null "$DASHBOARD/login" || problems+=("dashboard tidak menjawab")

age=$(psql "$DATABASE_URL" -Atc \
  "select coalesce(extract(epoch from now() - max(ts))::bigint, 999999) from pool_snapshots" 2>/dev/null)
if [[ -z "$age" ]]; then
  problems+=("database tidak bisa dibaca")
elif (( age > MAX_SNAPSHOT_AGE_S )); then
  problems+=("ingestor diam: snapshot pool terakhir $((age / 60)) menit lalu")
fi

now_state="ok"
(( ${#problems[@]} > 0 )) && now_state="down"
was_state="$(cat "$STATE" 2>/dev/null || echo ok)"
echo "$now_state" > "$STATE"

[[ "$now_state" == "$was_state" ]] && exit 0   # only the change is worth a message
[[ -z "${TELEGRAM_BOT_TOKEN:-}" || -z "${TELEGRAM_CHAT_ID:-}" ]] && exit 0

if [[ "$now_state" == "down" ]]; then
  text="🔴 <b>Quant bermasalah</b>%0A$(printf '· %s%%0A' "${problems[@]}")%0AServer: $(hostname)"
else
  text="🟢 <b>Quant normal lagi</b>%0ASemua layanan menjawab dan data mengalir."
fi

curl -s --max-time 15 -o /dev/null \
  "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
  --data-urlencode "parse_mode=HTML" \
  --data "text=${text}"
