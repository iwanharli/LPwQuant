"""Pools for buying low and selling high with limit orders, each with parameters and a 48-hour replay.

A buy order below the price that turns into a sell order above it earns the gap between them -- as long as the
price keeps swinging. So the pools picked here are safe, busy, and moving sideways (ranging regime or a high
reversal rate, no strong trend), and the order spacing comes from each pool's own 30-minute ATR: a step the price
actually covers in half an hour, not a guess.

Every pick is replayed on its last 48 hours of 30-minute candles with the exact rule the page suggests: buy one
step below, sell two steps above the buy, cut at three steps below the buy. Candle order inside a bar is unknown,
so a bar that touches both the stop and the target counts as the stop. Past fills do not promise future ones; the
replay only shows whether the rule would have worked here recently.
"""

import statistics
from typing import Any

from .alerts import top10_pct
from .scoring import RISKY_FLAGS

BLOCKING = RISKY_FLAGS | {"serial_dev", "bundler_heavy", "top_holders_50", "security_pending", "tvl_suspect"}
MIN_TVL = 20_000.0
MIN_VOLUME_24H = 100_000.0
MIN_AGE_HOURS = 6.0
MAX_TOP10 = 30.0
MIN_REVERSAL = 0.4
ATR_RANGE = (0.5, 6.0)
STEP_RANGE = (1.0, 4.0)  # % between the buy and the current price; below 1% fills are noise, above 4% rare
SELL_STEPS = 2.0
STOP_STEPS = 3.0
REPLAY_HOURS = 48
LIMIT = 12


def _quote(name: str) -> str | None:
    tail = name.rsplit("-", 1)[-1].upper() if "-" in name else ""
    return tail if tail in ("SOL", "USDC") else None


def eligible(row: dict[str, Any]) -> tuple[bool, str]:
    m = row.get("market") or {}
    if not _quote(row.get("name") or ""):
        return False, "bukan pasangan SOL/USDC"
    if set(row.get("flags") or []) & BLOCKING or not row.get("security"):
        return False, "tidak lolos keamanan"
    top10 = top10_pct(row)
    if top10 is None or top10 > MAX_TOP10:
        return False, "holder terlalu terpusat"
    if (row.get("pool_age_hours") or 0) < MIN_AGE_HOURS:
        return False, "pool terlalu baru"
    if (row.get("tvl") or 0) < MIN_TVL or (row.get("volume_24h") or 0) < MIN_VOLUME_24H:
        return False, "likuiditas atau volume kecil"
    atr = m.get("atr_pct")
    if atr is None or not ATR_RANGE[0] <= atr <= ATR_RANGE[1]:
        return False, "volatilitas di luar rentang"
    if m.get("regime") == "trending_down" or abs(m.get("change_24h_pct") or 0) > 30:
        return False, "sedang tren kuat"
    if m.get("regime") != "ranging" and (m.get("reversal_rate") or 0) < MIN_REVERSAL:
        return False, "harga jarang bolak-balik"
    return True, ""


def replay(candles: list[dict[str, float]], step: float) -> dict[str, Any]:
    """Buy `step`% below, sell SELL_STEPS x step above the buy, stop STOP_STEPS x step below it; repeat."""
    s = step / 100
    if len(candles) < 2:
        return {"cycles": 0, "stops": 0, "return_pct": 0.0, "holding": False, "fills": 0}
    buy = candles[0]["close"] * (1 - s)
    holding, entry = False, 0.0
    cycles = stops = fills = 0
    realized = 0.0
    for c in candles[1:]:
        if not holding:
            if c["low"] <= buy:
                holding, entry, fills = True, buy, fills + 1
            continue
        stop, target = entry * (1 - STOP_STEPS * s), entry * (1 + SELL_STEPS * s)
        if c["low"] <= stop:
            realized += -STOP_STEPS * step
            stops += 1
            holding, buy = False, c["close"] * (1 - s)
        elif c["high"] >= target:
            realized += SELL_STEPS * step
            cycles += 1
            fills += 1
            holding, buy = False, target * (1 - s)
    unrealized = (candles[-1]["close"] / entry - 1) * 100 if holding else 0.0
    return {"cycles": cycles, "stops": stops, "return_pct": realized + unrealized, "holding": holding, "fills": fills}


async def recommendations(db, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    picks = [r for r in rows if eligible(r)[0]]
    if not picks:
        return []
    candles = await db.fetch(
        """select address, ts, high, low, close from candles
           where timeframe = '30m' and address = any($1) and ts >= now() - make_interval(hours => $2) order by ts""",
        [r["address"] for r in picks],
        REPLAY_HOURS,
    )
    by_pool: dict[str, list[dict[str, float]]] = {}
    for c in candles:
        by_pool.setdefault(c["address"], []).append({"high": c["high"], "low": c["low"], "close": c["close"]})

    out = []
    for r in picks:
        m = r["market"]
        step = round(min(STEP_RANGE[1], max(STEP_RANGE[0], m["atr_pct"])), 1)
        price = r.get("price") or 0
        sim = replay(by_pool.get(r["address"], []), step)
        buy = price * (1 - step / 100)
        out.append({
            "address": r["address"],
            "name": r["name"],
            "quote": _quote(r["name"]),
            "price": price,
            "tvl": r.get("tvl"),
            "volume_24h": r.get("volume_24h"),
            "base_fee_pct": r.get("base_fee_pct"),
            "bin_step": r.get("bin_step"),
            "regime": m.get("regime"),
            "reversal_rate": m.get("reversal_rate"),
            "atr_pct": m.get("atr_pct"),
            "change_24h_pct": m.get("change_24h_pct"),
            "step_pct": step,
            "buy_pct": -step,
            "sell_pct": SELL_STEPS * step,        # above the buy price
            "stop_pct": -STOP_STEPS * step,       # below the buy price
            "buy_price": buy,
            "sell_price": buy * (1 + SELL_STEPS * step / 100),
            "stop_price": buy * (1 - STOP_STEPS * step / 100),
            "replay": {**sim, "hours": REPLAY_HOURS, "candles": len(by_pool.get(r["address"], []))},
        })
    # Pools whose replay made money and completed at least one cycle first; then by that return.
    out.sort(key=lambda x: (x["replay"]["cycles"] > 0 and x["replay"]["return_pct"] > 0, x["replay"]["return_pct"]), reverse=True)
    return out[:LIMIT]


def summary_stats(recs: list[dict[str, Any]]) -> dict[str, Any]:
    rets = [r["replay"]["return_pct"] for r in recs]
    return {"count": len(recs), "median_replay_pct": statistics.median(rets) if rets else None}
