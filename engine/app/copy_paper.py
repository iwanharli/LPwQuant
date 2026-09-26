"""Paper test: copying the LP leaderboard's best wallets, $100 per copied position.

The wallets followed are the top FOLLOW of the leaderboard that meet every "Layak diikuti" criterion, by their last
seven days. Every TICK_S their open positions are read from Meteora:

  * a position not seen before, created in the last FRESH_MIN minutes, is copied: the copy starts at the moment we
    saw it, so the delay is real. Its starting mark is the wallet's own PnL % at that moment;
  * when the position is gone from their open list, the copy closes at the wallet's final PnL % for it.

Copy result = (1 + final %) / (1 + % when we saw it) - 1, on SIZE_USD: the part of the wallet's result that was
still to come when a copier could have joined. Fees are inside Meteora's PnL, and scale with size, so they carry
over. Costs are our own: transaction fees and selling the tokens left at exit. Bin-array rent is left at zero -- the
wallet being copied has already opened those arrays.

Positions already open on the first look are only marked as seen, never copied mid-way.
"""

import asyncio
import logging
import time
from datetime import datetime, timezone
from typing import Any, Callable

from . import lp_leaders, portfolio

log = logging.getLogger("copy_paper")

TICK_S = 120
FOLLOW = 5
SIZE_USD = 100.0
FRESH_MIN = 30
TX_FEE_SOL = 0.0006  # open, add, remove, close
EXIT_SWAP_PCT = 0.3  # selling the token part left at exit, as % of the position


def copy_return_pct(entry_pct: float | None, now_pct: float | None) -> float:
    """What a copier made from the moment it joined: (1 + now) / (1 + entry) - 1, in %. A wallet mark at or below
    -99% when we joined means the value was already gone (or Meteora reported nothing): nothing left to copy."""
    base = 1 + (entry_pct or 0) / 100
    if base <= 0.01:
        return 0.0
    return ((1 + (now_pct or 0) / 100) / base - 1) * 100


def _open_positions(wallet: str) -> list[dict[str, Any]]:
    """The wallet's open DLMM positions with Meteora's PnL. Blocking."""
    body = portfolio._get("/portfolio/open", {"user": wallet, "page_size": 50})
    out = []
    for item in body.get("pools") or []:
        pool = item.get("poolAddress")
        detail = portfolio._get(f"/positions/{pool}/pnl", {"user": wallet, "status": "open", "page_size": 50})
        for p in detail.get("positions") or []:
            if p.get("isClosed"):
                continue
            q = portfolio._position(p)
            q.update(pool=pool, pair=f"{item.get('tokenX') or '?'}/{item.get('tokenY') or '?'}")
            out.append(q)
        time.sleep(0.15)
    return out


def _final_pnl_pct(wallet: str, pool: str, position: str) -> float | None:
    """The wallet's final PnL % for a position that just closed. Blocking."""
    for q in portfolio._closed_positions(wallet, pool):
        if q["address"] == position:
            return q["pnl_pct"]
    return None


async def followed(db) -> list[dict[str, Any]]:
    rep = await lp_leaders.report(db)
    return [l for l in rep["leaders"] if l["meets"]][:FOLLOW]


class CopyPaper:
    def __init__(self, db, sol_usd: Callable[[], float]) -> None:
        self.db = db
        self.sol_usd = sol_usd

    async def run(self) -> None:
        while True:
            try:
                await self.step()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("copy paper tick failed")
            await asyncio.sleep(TICK_S)

    async def step(self) -> None:
        now = datetime.now(timezone.utc)
        wallets = [l["wallet"] for l in await followed(self.db)]
        for w in wallets:
            try:
                live = await asyncio.to_thread(_open_positions, w)
            except Exception as err:
                log.info("copy %s read failed: %s", w[:4], err)
                continue
            first_look = not await self.db.fetchval("select 1 from paper_copy_seen where wallet = $1 limit 1", w)
            live_ids = {q["address"] for q in live}
            for q in live:
                if await self.db.fetchval("select 1 from paper_copy_seen where position = $1", q["address"]):
                    await self.db.execute(
                        "update paper_copy_runs set last_pnl_pct = $2, checked_at = $3 where position = $1 and status = 'open'",
                        q["address"], q["pnl_pct"], now)
                    continue
                await self.db.execute(
                    "insert into paper_copy_seen (position, wallet, first_seen) values ($1, $2, $3) on conflict do nothing",
                    q["address"], w, now)
                created = (q.get("created_at") or 0) / 1000
                if first_look or time.time() - created > FRESH_MIN * 60:
                    continue
                if (q["pnl_pct"] or 0) <= -50:
                    continue  # already down half on arrival: a broken or emptied position, not one to copy
                await self.db.execute(
                    """insert into paper_copy_runs (wallet, position, pool, pair, their_created_at, opened_at, status,
                         size_usd, entry_pnl_pct, last_pnl_pct, their_deposit_usd, min_price, max_price, checked_at)
                       values ($1,$2,$3,$4,to_timestamp($5),$6,'open',$7,$8,$8,$9,$10,$11,$6)""",
                    w, q["address"], q["pool"], q["pair"], created, now, SIZE_USD, q["pnl_pct"] or 0.0,
                    q.get("deposit_usd"), q.get("min_price"), q.get("max_price"))
                log.info("copy %s: %s %s (seen %.0fs after they opened)", w[:4], q["pair"], q["address"][:6], time.time() - created)
            # Copies whose position left the wallet's open list: close at the wallet's final result.
            for r in await self.db.fetch("select * from paper_copy_runs where wallet = $1 and status = 'open'", w):
                if r["position"] in live_ids:
                    continue
                final = await asyncio.to_thread(_final_pnl_pct, w, r["pool"], r["position"])
                if final is None:
                    final = r["last_pnl_pct"]  # not listed as closed yet: the last mark we saw
                result_pct = copy_return_pct(r["entry_pnl_pct"], final)
                costs = TX_FEE_SOL * self.sol_usd() + r["size_usd"] * EXIT_SWAP_PCT / 100
                pnl = r["size_usd"] * result_pct / 100 - costs
                await self.db.execute(
                    """update paper_copy_runs set status = 'closed', closed_at = $2, exit_pnl_pct = $3, result_pct = $4,
                         costs_usd = $5, pnl_usd = $6 where id = $1""",
                    r["id"], now, final, result_pct, costs, pnl)
                log.info("copy %s closed %s: %+.2f USD", w[:4], r["pair"], pnl)


async def report(db, rows: dict[str, dict[str, Any]] | None = None) -> dict[str, Any]:
    runs = [dict(r) for r in await db.fetch("select * from paper_copy_runs order by opened_at desc limit 300")]
    ms = lambda t: int(t.timestamp() * 1000) if t else None  # noqa: E731
    closed = [r for r in runs if r["status"] == "closed"]
    out = []
    for r in runs:
        running_pct = copy_return_pct(r["entry_pnl_pct"], r["last_pnl_pct"])
        out.append({
            "id": r["id"], "wallet": r["wallet"], "position": r["position"], "pool": r["pool"], "pair": r["pair"],
            "status": r["status"], "size_usd": r["size_usd"],
            "delay_s": (r["opened_at"] - r["their_created_at"]).total_seconds() if r["their_created_at"] else None,
            "entry_pnl_pct": r["entry_pnl_pct"], "last_pnl_pct": r["last_pnl_pct"], "exit_pnl_pct": r["exit_pnl_pct"],
            "result_pct": r["result_pct"] if r["status"] == "closed" else running_pct,
            "pnl_usd": r["pnl_usd"] if r["status"] == "closed" else r["size_usd"] * running_pct / 100,
            "costs_usd": r["costs_usd"], "their_deposit_usd": r["their_deposit_usd"],
            "min_price": r["min_price"], "max_price": r["max_price"],
            "price": ((rows or {}).get(r["pool"]) or {}).get("price"),
            "opened_at": ms(r["opened_at"]), "closed_at": ms(r["closed_at"]), "checked_at": ms(r["checked_at"]),
        })
    return {
        "params": {"follow": FOLLOW, "size_usd": SIZE_USD, "tick_s": TICK_S, "fresh_min": FRESH_MIN,
                   "exit_swap_pct": EXIT_SWAP_PCT},
        "wallets": await followed(db),
        "counts": {"open": len(runs) - len(closed), "closed": len(closed)},
        "pnl_usd": sum(r["pnl_usd"] or 0 for r in closed),
        "win_rate": sum((r["pnl_usd"] or 0) > 0 for r in closed) / len(closed) if closed else None,
        "runs": out,
    }
