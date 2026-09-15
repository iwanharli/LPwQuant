"""Per-pool chart data: OHLCV candles for several timeframes, and how each risk profile would treat the pool.

Meteora's OHLCV endpoint only serves 5m, 30m, 1h and 4h candles, each with a maximum window per request
(5m: 6h, 30m: 48h, 1h: 72h, 4h: 240h); longer histories are fetched as consecutive windows. 30m candles come
from our own `candles` table (the ingestor keeps ~8 days) when present.
"""

import asyncio
import json
import time
import urllib.request
from dataclasses import dataclass
from typing import Any

import asyncpg

from . import config
from .paper import PaperTrader, profile_plan

HOUR_S = 3600


@dataclass(frozen=True)
class Timeframe:
    key: str
    seconds: int
    max_window_hours: int  # Meteora per-request limit
    default_hours: int
    cache_ttl_s: int


TIMEFRAMES = {
    "5m": Timeframe("5m", 300, 6, 24, 60),
    "30m": Timeframe("30m", 1800, 48, 168, 120),
    "1h": Timeframe("1h", 3600, 72, 168, 300),
    "4h": Timeframe("4h", 14_400, 240, 720, 600),
}
MAX_HOURS = 720
_cache: dict[tuple[str, str, int], tuple[float, dict[str, Any]]] = {}
_CACHE_MAX = 200


def windows(end_s: int, hours: int, max_window_hours: int) -> list[tuple[int, int]]:
    """Consecutive (start, end) second windows covering `hours` back from `end_s`, newest first."""
    out = []
    start_s = end_s - hours * HOUR_S
    cursor = end_s
    while cursor > start_s:
        lo = max(start_s, cursor - max_window_hours * HOUR_S)
        out.append((lo, cursor))
        cursor = lo
    return out


def merge_candles(chunks: list[list[dict[str, Any]]]) -> list[dict[str, Any]]:
    by_ts: dict[int, dict[str, Any]] = {}
    for chunk in chunks:
        for c in chunk:
            by_ts[int(c["ts"])] = c  # overlapping windows repeat the edge candle
    return [by_ts[t] for t in sorted(by_ts)]


def trim_inactive_start(candles: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Drop the zero-volume candles before a pool's first trade: Meteora returns flat, near-zero candles for
    the time before liquidity arrived, which squash the real price action on long timeframes."""
    for i, c in enumerate(candles):
        if (c.get("volume") or 0) > 0:
            return candles[i:]
    return candles


def _fetch_window(address: str, tf: str, start_s: int, end_s: int) -> list[dict[str, Any]]:
    url = f"{config.METEORA_API_URL}/pools/{address}/ohlcv?timeframe={tf}&start_time={start_s}&end_time={end_s}"
    req = urllib.request.Request(url, headers={"User-Agent": "quant-engine/0.1", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as res:
        body = json.load(res)
    return [
        {"ts": int(c["timestamp"]) * 1000, "open": c["open"], "high": c["high"], "low": c["low"], "close": c["close"],
         "volume": c.get("volume") or 0.0}
        for c in body.get("data") or []
    ]


async def _from_db(db: asyncpg.Pool, address: str, hours: int) -> list[dict[str, Any]]:
    rows = await db.fetch(
        """select (extract(epoch from ts) * 1000)::bigint as ts, open, high, low, close, volume
           from candles where address = $1 and timeframe = '30m' and ts > now() - make_interval(secs => $2)
           order by ts""",
        address, hours * HOUR_S,
    )
    return [dict(r) for r in rows]


async def load_candles(db: asyncpg.Pool | None, address: str, tf_key: str, hours: int | None) -> dict[str, Any]:
    tf = TIMEFRAMES[tf_key]
    hours = min(MAX_HOURS, hours or tf.default_hours)
    key = (address, tf_key, hours)
    now = time.time()
    hit = _cache.get(key)
    if hit and hit[0] > now:
        return hit[1]

    candles: list[dict[str, Any]] = []
    source = "meteora"
    if tf_key == "30m" and db is not None:
        candles = await _from_db(db, address, hours)
        source = "db"
    if not candles:
        source = "meteora"
        spans = windows(int(now), hours, tf.max_window_hours)
        chunks = await asyncio.gather(*(asyncio.to_thread(_fetch_window, address, tf_key, lo, hi) for lo, hi in spans))
        candles = merge_candles(list(chunks))
    candles = trim_inactive_start(candles)

    result = {"address": address, "tf": tf_key, "hours": hours, "source": source, "candles": candles}
    if len(_cache) >= _CACHE_MAX:
        _cache.pop(min(_cache, key=lambda k: _cache[k][0]))
    _cache[key] = (now + tf.cache_ttl_s, result)
    return result


def profile_decision(row: dict[str, Any], trader: PaperTrader) -> dict[str, Any]:
    """Would this profile open a position in the pool right now, and if not, why. Open-position slots and the
    cooldown can still delay an entry the rules allow."""
    cfg = trader.cfg
    info: dict[str, Any] = {"key": cfg.profile, "label": cfg.label}
    held = [p for p in trader.open.values() if p.address == row["address"]]
    if held:
        pos = held[0]
        info["holding"] = {
            "id": pos.id, "entry_ts": pos.entry_ts, "capital_usd": pos.capital_usd, "pnl_pct": pos.pnl_pct(),
            "min_price": pos.min_price, "max_price": pos.max_price, "in_range": pos.lp.in_range(pos.last_price),
        }
    plan = profile_plan(row, cfg)
    if plan is not None and (plan.get("size_usd") or 0.0) >= max(1.0, cfg.min_position_usd):
        rules = plan.get("exit") or {}
        return {**info, "enter": True, "reason": None, "size_usd": plan["size_usd"],
                "stop_loss_pct": rules.get("stop_loss_pct"), "min_hold_hours": rules.get("min_hold_hours")}
    live = row.get("plan") or {}
    base = row.get("plan_base") or (live if live.get("action") == "enter" else None)
    if plan is not None:
        reason = f"Ukuran {plan.get('size_usd', 0):.2f} USD di bawah minimum {cfg.min_position_usd:g} USD"
    elif base is None:
        reason = live.get("reason") or "Tidak ada rencana masuk"
    elif base.get("tier") not in cfg.tiers:
        reason = f"Tier {base.get('tier')} tidak dipakai profil ini"
    else:
        ratio = cfg.min_fee_cost_ratio if cfg.min_fee_cost_ratio is not None else 0
        hours = cfg.fee_gate_hours if cfg.fee_gate_hours is not None else 1
        reason = f"Fee {hours:g} jam belum {ratio:g}x biaya bolak-balik"
    return {**info, "enter": False, "reason": reason}


async def pool_paper_positions(db: asyncpg.Pool, address: str, limit: int = 200) -> list[dict[str, Any]]:
    rows = await db.fetch(
        """select id, profile, status, tier, strategy, capital_usd, entry_price, exit_price, min_price, max_price,
                  pnl_pct, exit_reason, (extract(epoch from entry_ts) * 1000)::bigint as entry_ts,
                  (extract(epoch from exit_ts) * 1000)::bigint as exit_ts
           from paper_positions where address = $1 order by entry_ts desc limit $2""",
        address, limit,
    )
    return [dict(r) for r in rows]
