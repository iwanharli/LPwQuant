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

# Paper trading (app/paper.py). No transactions are ever sent.
PAPER_ENABLED = (os.getenv("PAPER_ENABLED") or "true").lower() != "false"
PAPER_START_EQUITY_USD = _num("PAPER_START_EQUITY_USD", PORTFOLIO_USD)
PAPER_MAX_OPEN_PER_TIER = int(_num("PAPER_MAX_OPEN_PER_TIER", 5))
PAPER_TIERS = tuple(t.strip() for t in (os.getenv("PAPER_TIERS") or "low,medium,high").split(",") if t.strip())
PAPER_COOLDOWN_HOURS = _num("PAPER_COOLDOWN_HOURS", 6)
PAPER_MIN_POSITION_USD = _num("PAPER_MIN_POSITION_USD", 25)
PAPER_MAX_DRAWDOWN_PCT = _num("PAPER_MAX_DRAWDOWN_PCT", 10)  # pause new entries below peak equity minus this
PAPER_COSTS_ENABLED =(os.getenv("PAPER_COSTS_ENABLED") or "true").lower() != "false"
PAPER_TX_COST_SOL = _num("PAPER_TX_COST_SOL", 0.00015)
PAPER_IMPACT_MULTIPLIER = _num("PAPER_IMPACT_MULTIPLIER", 1.0)
PAPER_NEW_BIN_ARRAY_SHARE = _num("PAPER_NEW_BIN_ARRAY_SHARE", 0.0)

# Keys shared with the ingestor (ingestor/src/redis.ts).
KEY_POOLS_LATEST = "pools:latest"
KEY_SECURITY_LATEST = "security:latest"
KEY_FLOW_LATEST = "flow:latest"
KEY_GMGN_LATEST = "gmgn:latest"
KEY_PAPER_OPEN_POOLS = "paper:open_pools"  # set: pools the ingestor must keep tracking
STREAM_POOLS = "stream:pools"
STREAM_PRICES = "stream:prices"
