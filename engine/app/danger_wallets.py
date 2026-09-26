"""Dangerous pool creators: wallets that created a DLMM pool and then drained it, or created a pool with several signs of
being a set-up rather than a market.

Every EVERY_S:
  * the newest pools from Meteora's API plus the screener's young pools are tracked for their first WATCH_HOURS: their
    creator (read on chain from the pool account, so it is known even after the pool is emptied) and peak TVL;
  * a tracked pool whose TVL falls under DRAIN_FRAC of a peak of at least MIN_PEAK_TVL is a "drained" event;
  * a screener row with 2+ danger signs is a "suspicious" event.
Each event is kept once per pool, with its evidence, and the creator appears on the list. Pools from a listed
creator get a danger sign of their own (service.danger_signs).
"""

import asyncio
import json
import logging
import time
import urllib.parse
from datetime import datetime, timezone
from typing import Any, Callable

from . import config, portfolio
from .lp_leaders import _get_json

log = logging.getLogger("danger_wallets")

EVERY_S = 300
WATCH_HOURS = 48
MIN_PEAK_TVL = 1000.0
DRAIN_FRAC = 0.1

# The creators on the list, kept in memory for the screener's danger signs (refreshed every round).
KNOWN: dict[str, int] = {}
CREATOR_OF: dict[str, str] = {}  # pool -> creator, for the pools being watched


async def _creators(pools: list[str]) -> dict[str, str | None]:
    out: dict[str, str | None] = {}
    for i in range(0, len(pools), 100):
        chunk = pools[i:i + 100]
        url = f"{config.CLAIM_SERVER_URL}/pool-creators?{urllib.parse.urlencode({'pools': ','.join(chunk)})}"
        try:
            out.update((await asyncio.to_thread(_get_json, url, 60)).get("creators") or {})
        except Exception as err:
            log.info("pool creators: %s", err)
    return out


async def _event(db, creator: str, kind: str, pool: str, name: str, evidence: dict[str, Any]) -> None:
    await db.execute(
        """insert into danger_events (pool, creator, kind, name, evidence, seen_at) values ($1,$2,$3,$4,$5::jsonb, now())
           on conflict (pool, kind) do nothing""",
        pool, creator, kind, name, json.dumps(evidence),
    )


async def step(db, rows: dict[str, dict[str, Any]]) -> None:
    now = time.time()
    try:
        body = await asyncio.to_thread(
            portfolio._get, "/pools",
            {"page": 1, "page_size": 100, "sort_by": "pool_created_at:desc", "filter_by": "is_blacklisted=false"})
        newest = body.get("data") or []
    except Exception as err:
        log.info("newest pools: %s", err)
        newest = []
    seen: dict[str, dict[str, Any]] = {}
    for p in newest:
        age_h = (now * 1000 - (p.get("created_at") or 0)) / 3_600_000
        if age_h <= WATCH_HOURS:
            seen[p["address"]] = {"name": p.get("name") or "?", "tvl": float(p.get("tvl") or 0), "created_at": p.get("created_at")}
    for r in rows.values():
        if (r.get("pool_age_hours") or 1e9) <= WATCH_HOURS:
            seen.setdefault(r["address"], {"name": r.get("name") or "?", "tvl": float(r.get("tvl") or 0), "created_at": None})

    tracked = {r["pool"]: dict(r) for r in await db.fetch(
        "select * from danger_pool_watch where first_seen > now() - make_interval(hours => $1)", WATCH_HOURS)}
    new = [a for a in seen if a not in tracked]
    creators = await _creators(new) if new else {}
    for a in new:
        info = seen[a]
        await db.execute(
            """insert into danger_pool_watch (pool, name, creator, peak_tvl, last_tvl, first_seen)
               values ($1,$2,$3,$4,$4, now()) on conflict (pool) do nothing""",
            a, info["name"], creators.get(a), info["tvl"])
    # Tracked pools that fell out of both lists (an emptied pool leaves the screener): ask Meteora directly.
    for a, t in tracked.items():
        if a in seen:
            continue
        try:
            p = await asyncio.to_thread(portfolio._get, f"/pools/{a}", {})
            seen[a] = {"name": t["name"], "tvl": float(p.get("tvl") or 0), "created_at": p.get("created_at")}
        except Exception:
            continue
        await asyncio.sleep(0.1)

    for a, info in seen.items():
        t = tracked.get(a)
        if t is None:
            continue
        peak = max(t["peak_tvl"] or 0.0, info["tvl"])
        await db.execute("update danger_pool_watch set peak_tvl = $2, last_tvl = $3 where pool = $1", a, peak, info["tvl"])
        creator = t["creator"]
        if not creator:
            continue
        if peak >= MIN_PEAK_TVL and info["tvl"] < peak * DRAIN_FRAC:
            await _event(db, creator, "drained", a, t["name"], {
                "peak_tvl": peak, "tvl_after": info["tvl"],
                "hours_after_seen": (now - t["first_seen"].timestamp()) / 3600})

    for r in rows.values():
        if len(r.get("danger") or []) >= 2:
            c = (await db.fetchval("select creator from danger_pool_watch where pool = $1", r["address"]))
            if c:
                await _event(db, c, "suspicious", r["address"], r.get("name") or "?", {"signs": r["danger"], "tvl": r.get("tvl")})

    CREATOR_OF.clear()
    for row in await db.fetch("select pool, creator from danger_pool_watch where creator is not null"):
        CREATOR_OF[row["pool"]] = row["creator"]
    KNOWN.clear()
    for row in await db.fetch("select creator, count(*) as n from danger_events group by creator"):
        KNOWN[row["creator"]] = row["n"]


async def loop(db, rows: Callable[[], dict[str, dict[str, Any]]]) -> None:
    await asyncio.sleep(60)
    while True:
        try:
            await step(db, rows())
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("danger wallets round failed")
        await asyncio.sleep(EVERY_S)


async def report(db) -> dict[str, Any]:
    events = [dict(r) for r in await db.fetch("select * from danger_events order by seen_at desc limit 1000")]
    by: dict[str, dict[str, Any]] = {}
    for e in events:
        w = by.setdefault(e["creator"], {"wallet": e["creator"], "drained": 0, "suspicious": 0, "drained_usd": 0.0,
                                         "last_at": None, "events": []})
        ev = json.loads(e["evidence"]) if isinstance(e["evidence"], str) else dict(e["evidence"])
        w[e["kind"]] += 1
        if e["kind"] == "drained":
            w["drained_usd"] += max(0.0, (ev.get("peak_tvl") or 0) - (ev.get("tvl_after") or 0))
        at = int(e["seen_at"].timestamp() * 1000)
        w["last_at"] = max(w["last_at"] or 0, at)
        w["events"].append({"pool": e["pool"], "name": e["name"], "kind": e["kind"], "at": at, "evidence": ev})
    wallets = sorted(by.values(), key=lambda w: (-(w["drained"] + w["suspicious"]), -(w["last_at"] or 0)))
    watched = await db.fetchval("select count(*) from danger_pool_watch where first_seen > now() - make_interval(hours => $1)", WATCH_HOURS)
    return {"wallets": wallets, "watched_pools": watched,
            "rules": {"watch_hours": WATCH_HOURS, "min_peak_tvl": MIN_PEAK_TVL, "drain_pct": DRAIN_FRAC * 100}}
