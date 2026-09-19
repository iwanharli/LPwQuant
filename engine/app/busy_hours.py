"""Busy hours: when in the day (WIB) a pool trades, from its 30-minute candles.

Each day is normalised to its own total before averaging, so one huge pump day cannot paint the whole profile.
Whether the profile means anything is measured, not assumed: the first half of the days is compared with the
second half, and only pools whose two halves agree (correlation >= STABLE_CORR over >= MIN_DAYS days) are called
stable. Across 95 pools with two weeks of data the median agreement was 0.40 and only a third were stable, while the
market as a whole showed a clear evening peak (20:00-01:00 WIB) -- so for most pools the market profile is the
better guide, and the page says which one it is showing.
"""

import statistics
import time
from typing import Any

MIN_DAYS = 14
STABLE_CORR = 0.5
CACHE_S = 3600  # candles arrive every 30 minutes; the shape of a month barely moves in an hour

_SQL = """
with c as (
  select address, (ts at time zone 'Asia/Jakarta') as t, volume from candles
  where timeframe = '30m' and ($1::text is null or address = $1)
), d as (
  select address, date_trunc('day', t) as day, extract(hour from t)::int as h, sum(volume) as v
  from c group by 1, 2, 3
), days as (
  select address, day, sum(v) as dv from d group by 1, 2 having sum(v) > 0
)
select d.address, d.day, d.h, d.v / days.dv as share from d join days using (address, day)
"""

_market: tuple[float, dict[str, Any]] | None = None


def _corr(a: list[float], b: list[float]) -> float:
    ma, mb = statistics.fmean(a), statistics.fmean(b)
    num = sum((x - ma) * (y - mb) for x, y in zip(a, b))
    den = (sum((x - ma) ** 2 for x in a) * sum((y - mb) ** 2 for y in b)) ** 0.5
    return num / den if den else 0.0


def _profile(days: dict[Any, list[float]], keys: list[Any]) -> list[float]:
    return [statistics.fmean(days[k][h] for k in keys) * 100 for h in range(24)]


def summarize(days: dict[Any, list[float]]) -> dict[str, Any]:
    """Profile (percent of a day's volume per hour), day count, split-half agreement and whether it is stable."""
    keys = sorted(days)
    if not keys:
        return {"profile": None, "days": 0, "consistency": None, "stable": False, "peak_hours": []}
    profile = _profile(days, keys)
    consistency = None
    if len(keys) >= 4:
        half = len(keys) // 2
        consistency = _corr(_profile(days, keys[:half]), _profile(days, keys[half:]))
    stable = len(keys) >= MIN_DAYS and consistency is not None and consistency >= STABLE_CORR
    peaks = sorted(range(24), key=lambda h: -profile[h])[:3]
    return {"profile": profile, "days": len(keys), "consistency": consistency, "stable": stable, "peak_hours": sorted(peaks)}


def _group(rows) -> dict[str, dict[Any, list[float]]]:
    out: dict[str, dict[Any, list[float]]] = {}
    for r in rows:
        out.setdefault(r["address"], {}).setdefault(r["day"], [0.0] * 24)[r["h"]] = float(r["share"])
    return out


async def market_profile(db) -> dict[str, Any]:
    """Average of the per-pool profiles of pools with at least MIN_DAYS days, each pool weighted equally: the
    shape of the market's day, not of its biggest pool."""
    global _market
    if _market and time.time() - _market[0] < CACHE_S:
        return _market[1]
    grouped = _group(await db.fetch(_SQL, None))
    profiles = [summarize(d) for d in grouped.values()]
    usable = [p for p in profiles if p["days"] >= MIN_DAYS]
    profile = [statistics.fmean(p["profile"][h] for p in usable) for h in range(24)] if usable else None
    cons = [p["consistency"] for p in usable if p["consistency"] is not None]
    value = {
        "profile": profile,
        "pools": len(usable),
        "stable_share": (sum(p["stable"] for p in usable) / len(usable)) if usable else None,
        "median_consistency": statistics.median(cons) if cons else None,
        "peak_hours": sorted(sorted(range(24), key=lambda h: -profile[h])[:3]) if profile else [],
    }
    _market = (time.time(), value)
    return value


async def pool_profile(db, address: str) -> dict[str, Any]:
    grouped = _group(await db.fetch(_SQL, address))
    return {**summarize(grouped.get(address, {})), "market": await market_profile(db)}
