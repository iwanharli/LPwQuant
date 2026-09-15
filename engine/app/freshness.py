"""Data freshness per source, so a silently stalled fetcher shows up on the dashboard instead of stale numbers
looking normal."""

from dataclasses import dataclass
from typing import Any

import asyncpg


@dataclass(frozen=True)
class Source:
    key: str
    label: str
    query: str  # returns one timestamptz
    max_age_sec: int
    required: bool  # optional sources that never produced data are "off", not "stale"


SOURCES = (
    Source("pool_snapshots", "Snapshot pool (Meteora)", "select max(ts) from pool_snapshots", 5 * 60, True),
    Source("pool_metrics", "Skor engine", "select max(ts) from pool_metrics", 5 * 60, True),
    Source("price_ticks", "Harga on-chain (Helius)", "select max(ts) from price_ticks", 15 * 60, False),
    # Candle ts is the open time; the forming candle is refetched every ~10 minutes.
    Source("candles", "Candle 30m (Meteora)", "select max(ts) from candles where timeframe = '30m'", 50 * 60, True),
    Source("pool_flow", "Arus transaksi (GeckoTerminal)", "select max(ts) from pool_flow", 15 * 60, False),
    Source("token_security", "Keamanan token (RugCheck)", "select max(fetched_at) from token_security", 90 * 60, False),
    Source("token_insights", "Insider & dev (GMGN)", "select max(fetched_at) from token_insights", 3 * 3600, False),
    Source("paper_equity", "Paper trading", "select max(ts) from paper_equity", 5 * 60, False),
)


def freshness_status(last_ms: int | None, now_ms: int, max_age_sec: int, required: bool) -> str:
    if last_ms is None:
        return "stale" if required else "off"
    return "ok" if (now_ms - last_ms) / 1000 <= max_age_sec else "stale"


async def check_freshness(db: asyncpg.Pool, now_ms: int) -> dict[str, Any]:
    items = []
    async with db.acquire() as conn:
        for source in SOURCES:
            value = await conn.fetchval(source.query)
            last_ms = int(value.timestamp() * 1000) if value else None
            items.append({
                "key": source.key,
                "label": source.label,
                "last_ts": last_ms,
                "age_sec": (now_ms - last_ms) / 1000 if last_ms else None,
                "max_age_sec": source.max_age_sec,
                "status": freshness_status(last_ms, now_ms, source.max_age_sec, source.required),
            })
    stale = [i["label"] for i in items if i["status"] == "stale"]
    return {"generated_at": now_ms, "ok": not stale, "stale": stale, "items": items}
