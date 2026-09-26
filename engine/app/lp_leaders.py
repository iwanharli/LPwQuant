"""LP leaderboard: Meteora DLMM wallets that make money providing liquidity, measured the same way the paper tests
are (median, without the best three, time held), so a lucky wallet does not pass for a good one.

Every RUN_EVERY_S:
  1. the wallets holding a position in the busiest screener pools right now (ingestor, on chain),
  2. for each, Meteora's lifetime LP result (/portfolio/total); keep those with MIN_CLOSED+ closed positions in profit,
  3. for the best of those, their recent closed positions pool by pool (/positions/{pool}/pnl) -> the statistics,
  4. saved to lp_leaders, which the page reads.

Results are Meteora's PnL per position: what happened inside the position. Swaps a wallet made around it are not in
it -- right for judging LP skill, which is what someone copying the position would get.
"""

import asyncio
import json
import logging
import time
import urllib.parse
import urllib.request
from typing import Any

from . import config, portfolio

log = logging.getLogger("lp_leaders")

RUN_EVERY_S = 6 * 3600
POOLS = 40  # busiest screener pools to collect LP wallets from
MAX_CANDIDATES = 500
MAX_DEEP = 80  # wallets whose positions are read one by one
POOLS_PER_WALLET = 25  # most recent pools per wallet, for the position statistics
GAP_S = 0.15
# The criteria a wallet must meet to be worth following (shown on the page as the "Layak diikuti" badge).
MIN_CLOSED = 30
MIN_HOLD_H = 0.5
MIN_DEPOSIT, MAX_DEPOSIT = 50.0, 2000.0
ACTIVE_DAYS = 7


def _get_json(url: str, timeout: int = 30) -> Any:
    req = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "quant-engine/0.1"})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return json.load(res)


def _median(xs: list[float]) -> float | None:
    xs = sorted(xs)
    n = len(xs)
    return None if not n else xs[n // 2] if n % 2 else (xs[n // 2 - 1] + xs[n // 2]) / 2


def _positions(wallet: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """(closed pools, closed positions of the most recent pools) for one wallet. Blocking."""
    pools, page = [], 1
    while page <= 3:
        body = portfolio._get("/portfolio", {"user": wallet, "page": page, "page_size": 50})
        pools += body.get("pools") or []
        if not body.get("hasNext"):
            break
        page += 1
        time.sleep(GAP_S)
    pools.sort(key=lambda p: p.get("lastClosedAt") or 0, reverse=True)
    positions = []
    for p in pools[:POOLS_PER_WALLET]:
        try:
            for q in portfolio._closed_positions(wallet, p["poolAddress"]):
                positions.append({**q, "pool": p["poolAddress"], "pair": f"{p.get('tokenX') or '?'}/{p.get('tokenY') or '?'}"})
        except Exception as err:  # one pool failing leaves the rest
            log.debug("positions %s %s: %s", wallet[:4], p.get("poolAddress", "")[:4], err)
        time.sleep(GAP_S)
    return pools, positions


def stats(wallet: str, total: dict[str, Any], pools: list[dict[str, Any]], positions: list[dict[str, Any]], now_ms: int) -> dict[str, Any]:
    pnls = sorted(p["pnl_usd"] for p in positions)
    n = len(pnls)
    holds = [((p["closed_at"] or 0) - (p["opened_at"] or 0)) / 3_600_000 for p in positions if p["closed_at"] and p["opened_at"]]
    deposits = [p["deposit_usd"] for p in positions if p["deposit_usd"] > 0]
    recent = [p for p in positions if (p["closed_at"] or 0) >= now_ms - ACTIVE_DAYS * 86_400_000]
    fav: dict[str, float] = {}
    for p in positions:
        fav[p["pair"]] = fav.get(p["pair"], 0.0) + p["pnl_usd"]
    last = max((p["closed_at"] or 0 for p in positions), default=0) or None
    s = {
        "wallet": wallet,
        "lifetime_pnl_usd": float(total.get("totalPnlUsd") or 0),
        "lifetime_closed": int(total.get("totalClosedPositions") or 0),
        "pools_total": len(pools),
        "sample": n,
        "pnl_usd": sum(pnls),
        "wins": sum(x > 0 for x in pnls),
        "win_rate": sum(x > 0 for x in pnls) / n if n else None,
        "median_usd": _median(pnls),
        "median_pct": _median([p["pnl_pct"] for p in positions]),
        "without_best3_usd": sum(pnls[:-3]) if n > 3 else None,
        "worst_usd": pnls[0] if n else None,
        "fees_usd": sum(p["fees_usd"] for p in positions),
        "hold_median_h": _median(holds),
        "deposit_median_usd": _median(deposits),
        "pnl_7d_usd": sum(p["pnl_usd"] for p in recent),
        "positions_7d": len(recent),
        "last_closed_at": last,
        "top_pairs": [k for k, _ in sorted(fav.items(), key=lambda kv: -kv[1])[:3]],
    }
    s["meets"] = bool(
        s["lifetime_closed"] >= MIN_CLOSED and s["median_usd"] is not None and s["median_usd"] > 0
        and (s["without_best3_usd"] or 0) > 0 and (s["hold_median_h"] or 0) >= MIN_HOLD_H
        and s["deposit_median_usd"] is not None and MIN_DEPOSIT <= s["deposit_median_usd"] <= MAX_DEPOSIT
        and s["positions_7d"] > 0
    )
    return s


async def refresh(db, rows: dict[str, dict[str, Any]]) -> int:
    busy = sorted(
        (r for r in rows.values() if r.get("tvl") and not {"rugged", "tvl_suspect"} & set(r.get("flags") or [])),
        key=lambda r: -(r.get("volume_24h") or 0),
    )[:POOLS]
    if not busy:
        return 0
    url = f"{config.CLAIM_SERVER_URL}/lp-owners?{urllib.parse.urlencode({'pools': ','.join(r['address'] for r in busy)})}"
    owners = (await asyncio.to_thread(_get_json, url, 300)).get("owners") or {}
    seen: dict[str, int] = {}
    for ws in owners.values():
        for w in ws:
            seen[w] = seen.get(w, 0) + 1
    candidates = sorted(seen, key=lambda w: -seen[w])[:MAX_CANDIDATES]
    log.info("lp leaders: %d wallets in %d pools", len(candidates), len(owners))

    totals: list[tuple[str, dict[str, Any]]] = []
    for w in candidates:
        try:
            t = await asyncio.to_thread(portfolio._get, "/portfolio/total", {"user": w})
        except Exception:
            continue
        if int(t.get("totalClosedPositions") or 0) >= MIN_CLOSED and float(t.get("totalPnlUsd") or 0) > 0:
            totals.append((w, t))
        await asyncio.sleep(GAP_S)
    totals.sort(key=lambda wt: -float(wt[1].get("totalPnlUsd") or 0))
    log.info("lp leaders: %d wallets with %d+ closed positions in profit", len(totals), MIN_CLOSED)

    now_ms = int(time.time() * 1000)
    saved = 0
    for w, t in totals[:MAX_DEEP]:
        try:
            pools, positions = await asyncio.to_thread(_positions, w)
        except Exception as err:
            log.warning("lp leaders %s: %s", w[:4], err)
            continue
        if not positions:
            continue
        s = stats(w, t, pools, positions, now_ms)
        await db.execute(
            """insert into lp_leaders (wallet, stats, updated_at) values ($1, $2::jsonb, now())
               on conflict (wallet) do update set stats = excluded.stats, updated_at = now()""",
            w, json.dumps(s),
        )
        saved += 1
    # Wallets not refreshed for two days have dropped out of the busy pools; keep the list current.
    await db.execute("delete from lp_leaders where updated_at < now() - interval '2 days'")
    log.info("lp leaders: saved %d", saved)
    return saved


async def loop(db, rows) -> None:
    await asyncio.sleep(120)  # let the screener fill first
    while True:
        try:
            await refresh(db, rows())
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("lp leaders refresh failed")
        await asyncio.sleep(RUN_EVERY_S)


async def report(db) -> dict[str, Any]:
    rows = await db.fetch("select stats, updated_at from lp_leaders")
    leaders = [json.loads(r["stats"]) if isinstance(r["stats"], str) else dict(r["stats"]) for r in rows]
    leaders.sort(key=lambda s: (not s["meets"], -(s["pnl_7d_usd"] or 0), -(s["pnl_usd"] or 0)))
    updated = max((r["updated_at"] for r in rows), default=None)
    return {
        "updated_at": int(updated.timestamp() * 1000) if updated else None,
        "criteria": {"min_closed": MIN_CLOSED, "min_hold_h": MIN_HOLD_H, "min_deposit": MIN_DEPOSIT,
                     "max_deposit": MAX_DEPOSIT, "active_days": ACTIVE_DAYS},
        "leaders": leaders,
    }
