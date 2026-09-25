#!/usr/bin/env bash
# Checks the three things that must be true for this system to be collecting data, and sends one Telegram message
# when that changes -- not every run. Meant for a systemd timer on the server.
#
#   1. the engine answers /api/health
#   2. the dashboard answers
#   3. the ingestor is still writing pool snapshots (data can go stale while the process looks alive)
#   4. the wallet history keeps up with the chain (it once stopped for hours on a new transaction version)
#   5. the on-chain new-pool subscription is still receiving DLMM logs
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

# 4. Newest transaction on chain vs newest one stored: behind by more than 20 minutes means the sync is stuck.
if [[ -n "${HELIUS_API_KEY:-}" ]]; then
  while read -r wallet; do
    [[ -z "$wallet" ]] && continue
    chain_ts=$(curl -s --max-time 15 "https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}" -H 'content-type: application/json' \
      -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getSignaturesForAddress\",\"params\":[\"$wallet\",{\"limit\":1}]}" \
      | grep -o '"blockTime":[0-9]*' | head -1 | cut -d: -f2)
    db_ts=$(psql "$DATABASE_URL" -Atc "select coalesce(extract(epoch from max(ts))::bigint, 0) from portfolio_activity where wallet = '$wallet' and sol_delta is not null" 2>/dev/null)
    if [[ -n "$chain_ts" && -n "$db_ts" ]] && (( chain_ts - db_ts > 1200 )); then
      problems+=("riwayat wallet ${wallet:0:4}… tertinggal $(( (chain_ts - db_ts) / 60 )) menit dari chain")
    fi
  done < <(psql "$DATABASE_URL" -Atc "select address from portfolio_wallets" 2>/dev/null)
fi

# 5. The ingestor refreshes this key every cycle while DLMM logs keep arriving.
if [[ "${ONCHAIN_NEW_POOLS:-true}" != "false" ]] && [[ -z "$(redis-cli --raw get onchain:alive 2>/dev/null)" ]]; then
  problems+=("deteksi pool on-chain berhenti (WebSocket DLMM tidak menerima log)")
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
