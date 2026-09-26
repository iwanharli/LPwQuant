"""Paper test: a grid of limit orders on SOL-USDC.

CAPITAL_USD is split over LEVELS buy orders STEP apart below the price (1%, 2%, ... 5% under). A level that buys
places its sell STEP above its own buy; once that sells it waits to buy again at the same price. So each round trip
makes STEP on the level's money, and the grid holds more SOL the further the price falls.

When the price runs STEP x RECENTER_STEPS above the highest buy and every level sits in USDC, the grid moves up to
the new price, so it does not sit idle through a rally. It never moves down and never stops out: in a falling
market the levels keep their SOL until the price comes back -- the risk this test is there to measure.

Fills: a buy fills when the price is at or below its level, a sell at or above; the price is read every TICK_S from
the busiest SOL-USDC DLMM pool. Meteora pays a limit order the pool's swap fee on top when it fills; that bonus is
left out, so results err low. Network fees: TX_FEE_SOL per placed and per filled order.
"""

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any

from . import portfolio

log = logging.getLogger("sol_grid")

POOL = "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6"  # SOL-USDC, bin step 4, the deepest DLMM pool
CAPITAL_USD = 1000.0
LEVELS = 5
STEP = 0.01
RECENTER_STEPS = 3
TICK_S = 30
TX_FEE_SOL = 0.00005
EQUITY_EVERY_S = 900


class SolGrid:
    def __init__(self, db) -> None:
        self.db = db
        self.last_equity = 0.0

    async def run(self) -> None:
        while True:
            try:
                await self.step()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("sol grid tick failed")
            await asyncio.sleep(TICK_S)

    async def _price(self) -> float:
        pool = await asyncio.to_thread(portfolio._get, f"/pools/{POOL}", {})
        return float(pool.get("current_price") or 0)

    async def _place(self, price: float, now: datetime, kind: str) -> None:
        """(Re)lay every level under `price`, all in USDC. Only when the grid holds no SOL."""
        per = CAPITAL_USD / LEVELS if kind == "start" else None
        rows = await self.db.fetch("select level, usd from paper_sol_grid order by level")
        usd = {r["level"]: r["usd"] for r in rows}
        await self.db.execute("delete from paper_sol_grid")
        for i in range(1, LEVELS + 1):
            buy = price * (1 - STEP * i)
            money = per if per is not None else usd.get(i, CAPITAL_USD / LEVELS)
            money -= TX_FEE_SOL * price  # placing the order
            await self.db.execute(
                "insert into paper_sol_grid values ($1, 'buy', $2, $3, $4, 0, $5)", i, buy, buy * (1 + STEP), money, now)
        await self.db.execute(
            "insert into paper_sol_grid_fills (ts, level, side, price, sol, usd) values ($1, 0, $2, $3, 0, 0)",
            now, "start" if kind == "start" else "recenter", price)

    async def step(self) -> None:
        now = datetime.now(timezone.utc)
        price = await self._price()
        if price <= 0:
            return
        levels = [dict(r) for r in await self.db.fetch("select * from paper_sol_grid order by level")]
        if not levels:
            await self._place(price, now, "start")
            log.info("sol grid started at %.2f", price)
            return
        fee = TX_FEE_SOL * price
        for lv in levels:
            if lv["state"] == "buy" and price <= lv["buy_price"]:
                sol = (lv["usd"] - fee) / lv["buy_price"]
                await self.db.execute(
                    "update paper_sol_grid set state = 'sell', sol = $2, usd = 0, updated_at = $3 where level = $1",
                    lv["level"], sol, now)
                await self.db.execute(
                    "insert into paper_sol_grid_fills (ts, level, side, price, sol, usd) values ($1,$2,'buy',$3,$4,$5)",
                    now, lv["level"], lv["buy_price"], sol, lv["usd"])
                lv.update(state="sell", sol=sol, usd=0)
            elif lv["state"] == "sell" and price >= lv["sell_price"]:
                usd = lv["sol"] * lv["sell_price"] - 2 * fee  # the fill, and placing the next buy
                spent = await self.db.fetchval(
                    "select usd from paper_sol_grid_fills where level = $1 and side = 'buy' order by ts desc limit 1",
                    lv["level"])
                await self.db.execute(
                    "update paper_sol_grid set state = 'buy', sol = 0, usd = $2, updated_at = $3 where level = $1",
                    lv["level"], usd, now)
                await self.db.execute(
                    """insert into paper_sol_grid_fills (ts, level, side, price, sol, usd, profit_usd)
                       values ($1,$2,'sell',$3,$4,$5,$6)""",
                    now, lv["level"], lv["sell_price"], lv["sol"], usd, usd - (spent or usd))
                lv.update(state="buy", sol=0, usd=usd)
        top = max(lv["buy_price"] for lv in levels)
        if all(lv["state"] == "buy" for lv in levels) and price > top * (1 + STEP * (RECENTER_STEPS + 1)):
            await self._place(price, now, "recenter")
            log.info("sol grid moved up to %.2f", price)
        if (now.timestamp() - self.last_equity) >= EQUITY_EVERY_S:
            self.last_equity = now.timestamp()
            equity = sum(lv["usd"] + lv["sol"] * price for lv in levels)
            await self.db.execute(
                "insert into paper_sol_grid_equity values ($1,$2,$3) on conflict do nothing", now, price, equity)


async def report(db) -> dict[str, Any]:
    levels = [dict(r) for r in await db.fetch("select * from paper_sol_grid order by level")]
    fills = [dict(r) for r in await db.fetch("select * from paper_sol_grid_fills order by ts desc limit 300")]
    first = await db.fetchrow("select ts, price from paper_sol_grid_fills where side = 'start' order by ts limit 1")
    try:
        price = float((await asyncio.to_thread(portfolio._get, f"/pools/{POOL}", {})).get("current_price") or 0)
    except Exception:
        price = 0.0
    equity = sum(lv["usd"] + lv["sol"] * price for lv in levels)
    sells = [f for f in fills if f["side"] == "sell"]
    ms = lambda t: int(t.timestamp() * 1000) if t else None  # noqa: E731
    return {
        "params": {"pool": POOL, "capital_usd": CAPITAL_USD, "levels": LEVELS, "step_pct": STEP * 100,
                   "recenter_steps": RECENTER_STEPS, "tick_s": TICK_S},
        "started_at": ms(first["ts"]) if first else None,
        "start_price": first["price"] if first else None,
        "price": price,
        "equity_usd": equity,
        "pnl_usd": equity - CAPITAL_USD,
        "hold_sol_usd": CAPITAL_USD * price / first["price"] if first and first["price"] else None,
        "realized_usd": sum(f["profit_usd"] or 0 for f in sells),
        "round_trips": len(sells),
        "sol_held": sum(lv["sol"] for lv in levels),
        "levels": [{**lv, "updated_at": ms(lv["updated_at"])} for lv in levels],
        "fills": [{**f, "ts": ms(f["ts"])} for f in fills],
        "equity": [
            {"ts": ms(r["ts"]), "equity_usd": r["equity_usd"], "price": r["price"]}
            for r in await db.fetch("select * from paper_sol_grid_equity order by ts")
        ],
    }
