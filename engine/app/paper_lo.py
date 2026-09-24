"""Paper limit orders: the Limit order tab's buy-low / sell-high rule, run by the engine on live prices.

Nothing is sent on chain. Every refresh the engine:
  * places a paper buy at the recommended level in recommended pools (0.5 SOL each, at most MAX_OPEN at once,
    one per pool, a cooldown after each close),
  * fills a waiting buy when the live price reaches it, then watches the sell target and the cut loss,
  * cancels a buy that has not filled in BUY_EXPIRY_H, and closes a position held HOLD_MAX_H at the market.

Honest by construction: fills use prices actually observed (about once a minute), so a stop fills at the price seen
after it was crossed, which can be worse than the stop; the maker fee bonus a real Meteora limit order earns is left
out; network fees are charged. PnL is kept in the quote token and in SOL.
"""

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from . import config, limit_recs

log = logging.getLogger("paper_lo")

SIZE_SOL = 0.5
MAX_OPEN = 6
BUY_EXPIRY_H = 12
HOLD_MAX_H = 24
COOLDOWN_H = 1
# Measured from this wallet's own LP transactions: 25,736 lamports on average, 67,051 at the 90th percentile.
# The order's account rent comes back when it is cancelled or withdrawn, so it is not a cost.
TX_FEE_SOL = 0.00006  # place + fill/withdraw
RECS_EVERY_S = 600


class PaperLimitOrders:
    def __init__(self, db) -> None:
        self.db = db
        self._recs: list[dict[str, Any]] = []
        self._recs_at = 0.0

    async def step(self, rows: dict[str, dict[str, Any]]) -> None:
        now = datetime.now(timezone.utc)
        sol_usd = self._sol_usd(rows)
        await self._manage(rows, now, sol_usd)
        if now.timestamp() - self._recs_at >= RECS_EVERY_S:
            self._recs = await limit_recs.recommendations(self.db, list(rows.values()))
            self._recs_at = now.timestamp()
        await self._open_new(now, sol_usd)

    @staticmethod
    def _sol_usd(rows: dict[str, dict[str, Any]]) -> float:
        # The deepest SOL-USDC pool's price is SOL in dollars.
        best = max(
            (r for r in rows.values() if r.get("name") in ("SOL-USDC", "WSOL-USDC") and r.get("price")),
            key=lambda r: r.get("tvl") or 0,
            default=None,
        )
        return float(best["price"]) if best else config.SOL_USD_FALLBACK

    async def _manage(self, rows: dict[str, dict[str, Any]], now: datetime, sol_usd: float) -> None:
        open_ = await self.db.fetch("select * from paper_lo_orders where status in ('waiting', 'holding')")
        for o in open_:
            row = rows.get(o["pool"])
            price = float(row["price"]) if row and row.get("price") else None
            if o["status"] == "waiting":
                if price is not None and price <= o["buy_price"]:
                    # Filled at the order's level; the price seen may be lower, but a limit order buys at its own.
                    qty = o["size_quote"] / o["buy_price"]
                    await self.db.execute(
                        "update paper_lo_orders set status = 'holding', filled_at = $2, qty = $3 where id = $1",
                        o["id"], now, qty,
                    )
                elif now - o["opened_at"] > timedelta(hours=BUY_EXPIRY_H):
                    await self._close(o, now, None, "expired", sol_usd)
                continue
            if price is None:
                continue
            if price <= o["stop_price"]:
                await self._close(o, now, price, "stop", sol_usd)  # at the price seen: slippage past the stop included
            elif price >= o["sell_price"]:
                await self._close(o, now, o["sell_price"], "target", sol_usd)
            elif now - o["filled_at"] > timedelta(hours=HOLD_MAX_H):
                await self._close(o, now, price, "time", sol_usd)

    async def _close(self, o, now: datetime, exit_price: float | None, reason: str, sol_usd: float) -> None:
        if reason == "expired":
            pnl_quote = 0.0
            fee_sol = TX_FEE_SOL / 2  # placing and cancelling, no fill
        else:
            pnl_quote = o["qty"] * exit_price - o["size_quote"]
            fee_sol = TX_FEE_SOL
        to_sol = 1.0 if o["quote"] == "SOL" else 1.0 / (o["sol_usd"] or sol_usd)
        pnl_sol = pnl_quote * to_sol - fee_sol
        await self.db.execute(
            """update paper_lo_orders set status = $2, closed_at = $3, exit_price = $4, exit_reason = $5,
                 pnl_quote = $6, pnl_sol = $7 where id = $1""",
            o["id"], "expired" if reason == "expired" else "closed", now, exit_price, reason, pnl_quote, pnl_sol,
        )
        log.info("paper LO %s %s: %s %+.4f SOL", o["name"], o["id"], reason, pnl_sol)

    async def _open_new(self, now: datetime, sol_usd: float) -> None:
        open_pools = {
            r["pool"] for r in await self.db.fetch("select pool from paper_lo_orders where status in ('waiting', 'holding')")
        }
        recent = {
            r["pool"]
            for r in await self.db.fetch(
                "select pool from paper_lo_orders where closed_at > $1", now - timedelta(hours=COOLDOWN_H)
            )
        }
        slots = MAX_OPEN - len(open_pools)
        for rec in self._recs:
            if slots <= 0:
                break
            if rec["address"] in open_pools or rec["address"] in recent or not rec.get("price"):
                continue
            # The replay no longer gates the picks: across the first 22 paper orders its 48-hour return correlated
            # -0.27 with the result, so pools are taken in the page's own order (reversal rate, then busyness).
            size = SIZE_SOL if rec["quote"] == "SOL" else SIZE_SOL * sol_usd
            await self.db.execute(
                """insert into paper_lo_orders (pool, name, quote, opened_at, status, step_pct, buy_price, sell_price,
                     stop_price, size_quote, sol_usd, replay_pct)
                   values ($1, $2, $3, $4, 'waiting', $5, $6, $7, $8, $9, $10, $11)""",
                rec["address"], rec["name"], rec["quote"], now, rec["step_pct"], rec["buy_price"], rec["sell_price"],
                rec["stop_price"], size, sol_usd, rec["replay"]["return_pct"],
            )
            open_pools.add(rec["address"])
            slots -= 1
            log.info("paper LO placed %s buy %.3e (step %.1f%%)", rec["name"], rec["buy_price"], rec["step_pct"])


async def report(db) -> dict[str, Any]:
    rows = [dict(r) for r in await db.fetch("select * from paper_lo_orders order by opened_at desc")]
    closed = [r for r in rows if r["status"] == "closed"]
    pnl = sum(r["pnl_sol"] or 0 for r in closed) + sum(r["pnl_sol"] or 0 for r in rows if r["status"] == "expired")
    by_reason: dict[str, int] = {}
    for r in closed:
        by_reason[r["exit_reason"]] = by_reason.get(r["exit_reason"], 0) + 1
    started = min((r["opened_at"] for r in rows), default=None)
    fmt = lambda t: int(t.timestamp() * 1000) if t else None  # noqa: E731
    return {
        "started_at": fmt(started),
        "size_sol": SIZE_SOL,
        "counts": {
            "total": len(rows),
            "waiting": sum(r["status"] == "waiting" for r in rows),
            "holding": sum(r["status"] == "holding" for r in rows),
            "closed": len(closed),
            "expired": sum(r["status"] == "expired" for r in rows),
            **by_reason,
        },
        "pnl_sol": pnl,
        "win_rate": (sum((r["pnl_sol"] or 0) > 0 for r in closed) / len(closed)) if closed else None,
        "avg_trade_pct": (
            sum((r["pnl_quote"] or 0) / r["size_quote"] * 100 for r in closed) / len(closed) if closed else None
        ),
        "orders": [
            {**{k: r[k] for k in ("id", "pool", "name", "quote", "status", "step_pct", "buy_price", "sell_price",
                                  "stop_price", "size_quote", "exit_price", "exit_reason", "pnl_quote", "pnl_sol",
                                  "replay_pct")},
             "opened_at": fmt(r["opened_at"]), "filled_at": fmt(r["filled_at"]), "closed_at": fmt(r["closed_at"])}
            for r in rows[:200]
        ],
    }
