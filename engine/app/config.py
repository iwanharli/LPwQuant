import os
from pathlib import Path
from urllib.parse import urlparse

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[2]
load_dotenv(ROOT / ".env")


def _num(name: str, default: float) -> float:
    raw = os.getenv(name)
    return float(raw) if raw not in (None, "") else default


TIMEZONE = os.getenv("TIMEZONE") or "Asia/Jakarta"  # GMT+7 for logs and display

DATABASE_URL = os.getenv("DATABASE_URL") or "postgres://localhost:5432/db_quant"
# asyncpg reads ~/.pgpass when no password is given and crashes on lines it can't parse.
# Skip that lookup unless a password source is configured explicitly.
DB_CONNECT_KWARGS: dict[str, str] = (
    {}
    if urlparse(DATABASE_URL).password or os.getenv("PGPASSWORD") or os.getenv("PGPASSFILE")
    else {"password": ""}
)
REDIS_URL = os.getenv("REDIS_URL") or "redis://localhost:6379/0"
ENGINE_HOST = os.getenv("ENGINE_HOST") or "127.0.0.1"
ENGINE_PORT = int(_num("ENGINE_PORT", 8000))
SCHEMA_PATH = ROOT / "db" / "schema.sql"

HISTORY_MS = int(_num("HISTORY_WINDOW_SEC", 7200) * 1000)
# Ignore API snapshot prices for pools that had an on-chain tick this recently.
TICK_PRECEDENCE_MS = 5 * 60 * 1000

# Position planning (app/recommend.py).
PORTFOLIO_USD = _num("PORTFOLIO_USD", 1000)
MAX_POSITION_PCT = _num("MAX_POSITION_PCT", 5)
HOLD_HOURS = _num("HOLD_HOURS", 4)
MIN_HOLD_HOURS = _num("MIN_HOLD_HOURS", 2)
MIN_FEE_COST_RATIO = _num("MIN_FEE_COST_RATIO", 2)
FEE_GATE_HOURS = _num("FEE_GATE_HOURS", 1)
# Reject plans whose round trip costs more than this share of the position: paper trading opened $100 positions
# in shallow pools at 2.3% and 3.9% round-trip cost, which no realistic fee rate pays back.
MAX_ROUND_TRIP_COST_PCT = _num("MAX_ROUND_TRIP_COST_PCT", 1.5)
# Cap on the plan stop-loss after the profile multiplier: positions were held to -16% before another rule closed them.
MAX_STOP_LOSS_PCT = _num("MAX_STOP_LOSS_PCT", 10)
SOL_USD_FALLBACK = _num("SOL_USD_FALLBACK", 150)
USD_IDR_FALLBACK = _num("USD_IDR", 16400)  # rupiah per dollar when the FX feed is unreachable  # backtest tx/rent costs; live uses the SOL pool price

# Paper trading (app/paper.py). No transactions are ever sent.
PAPER_ENABLED = (os.getenv("PAPER_ENABLED") or "true").lower() != "false"
PAPER_START_EQUITY_USD = _num("PAPER_START_EQUITY_USD", 500)  # same virtual capital for every risk profile
PAPER_MAX_OPEN_PER_TIER = int(_num("PAPER_MAX_OPEN_PER_TIER", 5))
PAPER_TIERS = tuple(t.strip() for t in (os.getenv("PAPER_TIERS") or "low,medium,high").split(",") if t.strip())
PAPER_COOLDOWN_HOURS = _num("PAPER_COOLDOWN_HOURS", 6)
PAPER_MIN_POSITION_USD = _num("PAPER_MIN_POSITION_USD", 25)
# Every paper position is at least this large (TVL cap permitting): fixed tx costs (~$0.06 per round trip) sink
# positions of a few dollars, which is what equity-based sizing gives on a $500 account.
PAPER_POSITION_FLOOR_USD = _num("PAPER_POSITION_FLOOR_USD", 100)
PAPER_MAX_DRAWDOWN_PCT = _num("PAPER_MAX_DRAWDOWN_PCT", 10)  # pause new entries below peak equity minus this
PAPER_COSTS_ENABLED =(os.getenv("PAPER_COSTS_ENABLED") or "true").lower() != "false"
PAPER_TX_COST_SOL = _num("PAPER_TX_COST_SOL", 0.00015)
PAPER_IMPACT_MULTIPLIER = _num("PAPER_IMPACT_MULTIPLIER", 1.0)
PAPER_NEW_BIN_ARRAY_SHARE = _num("PAPER_NEW_BIN_ARRAY_SHARE", 0.0)
# Share of the base tokens held at close that we sell back to the quote token right away (see costs.exit_cost).
PAPER_EXIT_SWAP_SHARE = _num("PAPER_EXIT_SWAP_SHARE", 1.0)
PAPER_PROFILES = tuple(
    p.strip() for p in (os.getenv("PAPER_PROFILES") or "moderat,tenang,satu_sisi,bolak_balik").split(",") if p.strip()
)

# Telegram alerts (engine/app/alerts.py). Without a token and chat id nothing is ever sent, so leaving these
# empty keeps the feature switched off. The token is a secret: keep it in .env, which is gitignored.
ALERTS_ENABLED = (os.getenv("ALERTS_ENABLED") or "true").lower() != "false"
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN") or ""
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID") or ""
ALERT_KINDS = tuple(
    k.strip() for k in (os.getenv("ALERT_KINDS") or "new_pool,gate,new_lp,stale").split(",") if k.strip()
)

# The ingestor's local transaction/wallet server (ingestor/src/claim-server.ts), which holds the RPC key.
CLAIM_SERVER_URL = (os.getenv("CLAIM_SERVER_URL") or f"http://127.0.0.1:{int(_num('CLAIM_PORT', 8010))}").rstrip("/")

# Keys shared with the ingestor (ingestor/src/redis.ts).
METEORA_API_URL = (os.getenv("METEORA_API_URL") or "https://dlmm.datapi.meteora.ag").rstrip("/")

KEY_POOLS_LATEST = "pools:latest"
KEY_SECURITY_LATEST = "security:latest"
KEY_FLOW_LATEST = "flow:latest"
KEY_GMGN_LATEST = "gmgn:latest"
KEY_JUPITER_LATEST = "jupiter:latest"
KEY_PUMP_LATEST = "pump:latest"  # hash: mint -> pump.fun token data  # hash: mint -> Jupiter organic score
KEY_BINS_LATEST = "bins:latest"  # hash: address -> bin liquidity around the active bin
KEY_PAPER_OPEN_POOLS = "paper:open_pools"  # set: pools the ingestor must keep tracking
STREAM_POOLS = "stream:pools"
STREAM_PRICES = "stream:prices"
