"""Every paper test on one yardstick, for the Paper trading overview.

Each strategy is reduced to its closed trades as (result in USD, capital in USD). From those: total, median, the
total without the best one and best three, win rate and return on the capital traded. The verdict needs at least
MIN_CLOSED trades and a positive median and "without best three" -- a result carried by one lucky pool is not one
to trade with real money.
"""

from datetime import datetime, timezone
from typing import Any

MIN_CLOSED = 20
# Fees faster than this (% of the position's capital per hour held) are not what a pool normally pays: a brief
# spike, or a model error. They are counted, but the result is also shown without them.
ODD_FEE_PCT_PER_HOUR = 3.0


def _row(key: str, label: str, tab: str, trades: list[tuple[float, float]], open_n: int, started, note: str,
         profile: str | None = None, holds: list[float] | None = None, recent_7d: float | None = None,
         opened: int | None = None, odd: list[float] | None = None, passing: int | None = None) -> dict[str, Any]:
    holds = [h for h in (holds or []) if h is not None and h >= 0]
    days = max(1.0, (datetime.now(timezone.utc) - started).total_seconds() / 86400) if started else None
    pnls = sorted(p for p, _ in trades)
    n = len(pnls)
    capital = sum(c for _, c in trades)
    median = (pnls[n // 2] if n % 2 else (pnls[n // 2 - 1] + pnls[n // 2]) / 2) if n else None
    without3 = sum(pnls[:-3]) if n > 3 else None
    if n < MIN_CLOSED:
        verdict = "data"
    elif (median or 0) > 0 and (without3 or 0) > 0:
        verdict = "viable"
    elif sum(pnls) > 0:
        verdict = "luck"
    else:
        verdict = "loss"
    return {
        "key": key, "label": label, "tab": tab, "profile": profile, "note": note,
        "closed": n, "open": open_n,
        # Pools (levels, for the grid) that pass the strategy's screen right now: the "y" of "x aktif / y lolos".
        "passing": passing,
        "started_at": int(started.timestamp() * 1000) if started else None,
        "pnl_usd": sum(pnls), "capital_usd": capital,
        "return_pct": sum(pnls) / capital * 100 if capital else None,
        "avg_size_usd": capital / n if n else None,
        "median_usd": median,
        "without_best_usd": sum(pnls[:-1]) if n > 1 else None,
        "without_best3_usd": without3,
        "win_rate": sum(p > 0 for p in pnls) / n if n else None,
        "wins": sum(p > 0 for p in pnls),
        # How long closed positions were held, in hours: the average and all of them together.
        # Result of the positions closed in the last seven days, and how often the strategy opens a position.
        "pnl_7d_usd": recent_7d,
        # Positions whose fees came in implausibly fast, and the result without them.
        "odd_fee_count": len(odd or []),
        "pnl_without_odd_usd": sum(pnls) - sum(odd or []) if odd else None,
        "positions_per_day": (opened / days) if opened is not None and days else None,
        "avg_hold_hours": sum(holds) / len(holds) if holds else None,
        "total_hold_hours": sum(holds) if holds else None,
        # The worst single trade, and what it was as a share of that trade's own capital.
        "worst_usd": min(trades)[0] if trades else None,
        "worst_pct": (min(trades)[0] / min(trades)[1] * 100) if trades and min(trades)[1] else None,
        "verdict": verdict,
    }


async def overview(db, papers: dict[str, Any], sol_usd: float, pools: dict[str, Any] | None = None) -> dict[str, Any]:
    from . import panda as panda_mod, profile_screen

    pools = pools or {}
    rows: list[dict[str, Any]] = []
    for key, trader in papers.items():
        closed = await db.fetch(
            """select capital_usd, pnl_pct, fee_pct, extract(epoch from exit_ts - entry_ts) / 3600 as hold_h,
                      exit_ts > now() - interval '7 days' as recent
               from paper_positions where profile = $1 and status = 'closed'""", key)
        agg = await db.fetchrow(
            "select count(*) filter (where status = 'open') as open, count(*) as n, min(entry_ts) as started from paper_positions where profile = $1",
            key)
        rows.append(_row(
            f"lp:{key}", trader.cfg.label, "lp",
            [(r["capital_usd"] * r["pnl_pct"] / 100, r["capital_usd"]) for r in closed],
            agg["open"], agg["started"], "Profil LP dari rencana screener", profile=key,
            holds=[float(r["hold_h"]) for r in closed if r["hold_h"] is not None],
            passing=profile_screen.screen(pools, trader)["funnel"].get("lolos", 0) if pools else None,
            recent_7d=sum(r["capital_usd"] * r["pnl_pct"] / 100 for r in closed if r["recent"]), opened=agg["n"],
            odd=[r["capital_usd"] * r["pnl_pct"] / 100 for r in closed
                 if (r["fee_pct"] or 0) / max(float(r["hold_h"] or 0), 1.0) >= ODD_FEE_PCT_PER_HOUR],
        ))

    panda = await db.fetch(
        """select status, size_usd, pnl_usd, fees_usd, opened_at, extract(epoch from closed_at - opened_at) / 3600 as hold_h,
                  closed_at > now() - interval '7 days' as recent
           from paper_panda_runs""")
    rows.append(_row(
        "panda", "Panda Strat", "panda",
        [(r["pnl_usd"] or 0, r["size_usd"]) for r in panda if r["status"] == "closed"],
        sum(r["status"] == "open" for r in panda), min((r["opened_at"] for r in panda), default=None),
        "Range lebar satu sisi, keluar di pantulan pertama",
        holds=[float(r["hold_h"]) for r in panda if r["status"] == "closed" and r["hold_h"] is not None],
        passing=sum(1 for row in pools.values() if panda_mod.screen(row)[0]) if pools else None,
        recent_7d=sum(r["pnl_usd"] or 0 for r in panda if r["status"] == "closed" and r["recent"]), opened=len(panda),
        odd=[r["pnl_usd"] or 0 for r in panda if r["status"] == "closed"
             and (r["fees_usd"] or 0) / r["size_usd"] * 100 / max(float(r["hold_h"] or 0), 1.0) >= ODD_FEE_PCT_PER_HOUR],
    ))

    grid = await db.fetch("select profit_usd, ts > now() - interval '7 days' as recent from paper_sol_grid_fills where side = 'sell'")
    grid_buys = await db.fetchval("select count(*) from paper_sol_grid_fills where side = 'buy'")
    # A round trip lasts from a level's buy to the sell that follows it.
    grid_holds = [float(r["h"]) for r in await db.fetch(
        """select extract(epoch from s.ts - (select max(b.ts) from paper_sol_grid_fills b
                                              where b.level = s.level and b.side = 'buy' and b.ts <= s.ts)) / 3600 as h
           from paper_sol_grid_fills s where s.side = 'sell'""") if r["h"] is not None]
    first = await db.fetchval("select min(ts) from paper_sol_grid_fills")
    held = await db.fetch("select sol, buy_price from paper_sol_grid where state = 'sell'")
    price = await db.fetchval("select price from paper_sol_grid_equity order by ts desc limit 1")
    # SOL still held counts at today's price, so a falling market shows as a loss here and not only on the grid tab.
    floating = [((price - h["buy_price"]) * h["sol"], 200.0) for h in held] if price else []
    rows.append(_row(
        "sol_grid", "Grid SOL-USDC", "sol",
        [(r["profit_usd"] or 0, 200.0) for r in grid] + floating, len(held), first,
        "5 limit order 1% di bawah harga, jual 1% di atasnya", holds=grid_holds,
        passing=await db.fetchval("select count(*) from paper_sol_grid"),
        recent_7d=sum(r["profit_usd"] or 0 for r in grid if r["recent"]), opened=grid_buys,
    ))
    return {"min_closed": MIN_CLOSED, "strategies": rows}
