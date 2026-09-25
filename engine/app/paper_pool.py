"""Paper test: would creating DLMM pools pay?

Nothing is sent on chain. Every TICK_S the engine:
  * looks at the newest Meteora DLMM pools and joins, on paper, those a pool creator would have made: under an hour
    old, base fee FEE_MIN_PCT or more, SOL or USDC quote, already trading. It joins as their first LP, as if it had
    created them, with SIZE_SOL in a spot range RANGE_LOW..RANGE_HIGH times the price,
  * credits the position its share of the fees the pool actually earned since the last tick (share = its value over
    its value + the larger of the pool's TVL at the start and end of the tick, at most MAX_SHARE, only while the
    price is inside its range),
  * closes on the first exit rule: liquidity pulled (TVL under PULLED_TVL_FRAC of its peak), loss past STOP_PCT,
    price below the range, fees dried up, or MAX_HOLD_H.

Version 1 (to 2026-09-25) used the end-of-tick TVL alone: when other LPs pulled out, TVL fell to ~0 and the whole
tick's fees -- earned while the pool was still deep -- were credited to the paper position. That, and five-minute
ticks that let stops fire at -70%, made its result unreliable. Runs are tagged with VERSION; the report shows the
current one.

Honest by construction: the pool's real fees and prices, a share that shrinks as other LPs arrive, the rent a
creator cannot get back (CREATE_COST_SOL, bin arrays and pool accounts), the swap into the token for the position's
token half and back out, and network fees. The result is also shown without the creation cost: the same trade as
joining someone else's pool first.
"""

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any, Callable

from . import portfolio

log = logging.getLogger("paper_pool")

VERSION = 2
TICK_S = 60
MAX_SHARE = 0.5  # never more than half the pool's fees: other LPs and the creator are in it too
PULLED_TVL_FRAC = 0.3
SIZE_SOL = 1.0
MAX_OPEN = 6
MAX_POOL_AGE_MIN = 60
FEE_MIN_PCT = 2.0
MIN_TVL_USD = 300.0
MIN_VOLUME_30M_USD = 3_000.0
RANGE_LOW, RANGE_HIGH = 0.3, 1.5  # spot, equal value per bin, log-spaced
RANGE_BINS = 60
STOP_PCT = -20.0
MAX_HOLD_H = 24
FEES_DRIED_AFTER_H = 2  # from then on, close when the last hour paid under FEES_DRIED_PCT of the capital
FEES_DRIED_PCT = 0.2
# Rent a pool creator never gets back, from the SDK's own constants (POOL_FEE, BIN_ARRAY_BITMAP_FEE,
# TOKEN_ACCOUNT_FEE, BIN_ARRAY_FEE): the pair account, its bitmap, the two reserve token accounts, and the bin
# arrays the first range creates. The position's own rent (POSITION_FEE 0.0574) comes back on close, so it is left
# out. A brand-new pool always pays the array rent -- nobody has opened those bins before.
POOL_FEE_SOL = 0.00718272
BIN_ARRAY_BITMAP_FEE_SOL = 0.01180416
TOKEN_ACCOUNT_FEE_SOL = 0.00203928
BIN_ARRAY_FEE_SOL = 0.07143744
NEW_BIN_ARRAYS = 2  # a range this wide spans two 70-bin arrays
CREATE_COST_SOL = POOL_FEE_SOL + BIN_ARRAY_BITMAP_FEE_SOL + 2 * TOKEN_ACCOUNT_FEE_SOL + NEW_BIN_ARRAYS * BIN_ARRAY_FEE_SOL
SWAP_COST_PCT = 1.0  # buying the token half on the way in, and selling what is left on the way out
TX_FEE_SOL = 0.0005  # create, add, remove, two swaps, priority fees included
QUOTES = {"So11111111111111111111111111111111111111112": "SOL", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": "USDC"}


def _bins() -> list[float]:
    return [RANGE_LOW * (RANGE_HIGH / RANGE_LOW) ** (i / (RANGE_BINS - 1)) for i in range(RANGE_BINS)]


def _bin_parts(ratio: float) -> tuple[float, float]:
    """(token value, quote value) per 1 of capital when the price is `ratio` times the entry. Spot: every bin starts
    with the same value, quote in bins below the entry price and the token in bins above it. The price crossing a bin
    converts it at that bin's price: bins it fell through now hold the token, bins it rose through hold quote."""
    token = quote = 0.0
    for p in _bins():
        if p <= 1.0:  # started as quote
            if ratio >= p:
                quote += 1.0
            else:
                token += ratio / p  # bought 1/p tokens at p
        else:  # started as 1 of token value, i.e. 1 token at the entry price
            if ratio < p:
                token += ratio
            else:
                quote += p  # sold at p
    return token / RANGE_BINS, quote / RANGE_BINS


def lp_value(ratio: float) -> float:
    token, quote = _bin_parts(ratio)
    return token + quote


def token_share(ratio: float) -> float:
    """Part of the position's value held in the token at `ratio`: what has to be sold on the way out."""
    token, quote = _bin_parts(ratio)
    return token / (token + quote) if token + quote else 0.0


def _f(v: Any) -> float:
    try:
        return float(v or 0)
    except (TypeError, ValueError):
        return 0.0


class PaperPoolCreator:
    def __init__(self, db, sol_usd: Callable[[], float]) -> None:
        self.db = db
        self.sol_usd = sol_usd

    async def run(self) -> None:
        while True:
            try:
                await self.step()
            except asyncio.CancelledError:
                raise
            except Exception:  # a failed tick must not end the test
                log.exception("paper pool tick failed")
            await asyncio.sleep(TICK_S)

    async def step(self) -> None:
        now = datetime.now(timezone.utc)
        sol = self.sol_usd()
        for r in await self.db.fetch("select * from paper_pool_runs where status = 'open' and version = $1", VERSION):
            await self._tick(dict(r), now, sol)
        await self._open_new(now, sol)

    async def _tick(self, r: dict[str, Any], now: datetime, sol: float) -> None:
        try:
            p = await asyncio.to_thread(portfolio._get, f"/pools/{r['pool']}", {})
        except Exception as err:
            log.warning("paper pool %s read failed: %s", r["name"], err)
            return
        price = _f(p.get("current_price"))
        tvl = _f(p.get("tvl"))
        cum = _f((p.get("cumulative_metrics") or {}).get("fees"))
        if price <= 0:
            await self._close(r, now, r["last_price"] or r["entry_price"], "vanished", sol)
            return
        ratio = price / r["entry_price"]
        value = r["size_usd"] * lp_value(ratio)
        in_range = RANGE_LOW <= ratio <= RANGE_HIGH
        earned = 0.0
        if in_range and cum > r["last_cum_fees"]:
            # Our liquidity would have been part of the pool: share of what the pool earned since the last tick.
            # Fees earned during the tick came from a pool at least as deep as its deeper end.
            depth = max(tvl, r["last_tvl"] or 0.0, 0.0)
            earned = (cum - r["last_cum_fees"]) * min(MAX_SHARE, value / (value + depth))
        peak_tvl = max(r.get("peak_tvl") or 0.0, r["last_tvl"] or 0.0, tvl)
        hours = max(TICK_S / 3600, ((now - r["checked_at"]).total_seconds() / 3600) if r["checked_at"] else TICK_S / 3600)
        fee_hour_pct = earned / hours / r["size_usd"] * 100
        await self.db.execute(
            """update paper_pool_runs set last_cum_fees = $2, fees_usd = fees_usd + $3, ticks = ticks + 1,
                 in_range_ticks = in_range_ticks + $4, last_price = $5, last_tvl = $6, checked_at = $7,
                 peak_fee_hour = greatest(peak_fee_hour, $8), peak_tvl = $9 where id = $1""",
            r["id"], cum, earned, int(in_range), price, tvl, now, fee_hour_pct, peak_tvl,
        )
        r.update(fees_usd=r["fees_usd"] + earned, last_price=price, last_tvl=tvl)
        held_h = (now - r["opened_at"]).total_seconds() / 3600
        pnl_pct = (value + r["fees_usd"] - r["size_usd"]) / r["size_usd"] * 100
        if peak_tvl > 0 and tvl < peak_tvl * PULLED_TVL_FRAC:
            await self._close(r, now, price, "pulled", sol)
        elif pnl_pct <= STOP_PCT:
            await self._close(r, now, price, "stop", sol)
        elif ratio < RANGE_LOW:
            await self._close(r, now, price, "below_range", sol)
        elif held_h >= FEES_DRIED_AFTER_H and fee_hour_pct < FEES_DRIED_PCT:
            await self._close(r, now, price, "fees_dried", sol)
        elif held_h >= MAX_HOLD_H:
            await self._close(r, now, price, "time", sol)

    async def _close(self, r: dict[str, Any], now: datetime, price: float, reason: str, sol: float) -> None:
        ratio = price / r["entry_price"]
        value = r["size_usd"] * lp_value(ratio)
        sol_usd = r["sol_usd"] or sol
        costs = (
            r["size_usd"] * token_share(1.0) * SWAP_COST_PCT / 100  # token part bought on the way in
            + value * token_share(ratio) * SWAP_COST_PCT / 100  # token left, sold on the way out
            + TX_FEE_SOL * sol_usd
        )
        create = CREATE_COST_SOL * sol_usd
        pnl = value + r["fees_usd"] - r["size_usd"] - costs - create
        await self.db.execute(
            """update paper_pool_runs set status = 'closed', closed_at = $2, exit_reason = $3, lp_value_usd = $4,
                 costs_usd = $5, create_cost_usd = $6, pnl_usd = $7, last_price = $8 where id = $1""",
            r["id"], now, reason, value, costs, create, pnl, price,
        )
        log.info("paper pool %s closed (%s): %+.2f USD, fees %.2f", r["name"], reason, pnl, r["fees_usd"])

    async def _open_new(self, now: datetime, sol: float) -> None:
        open_rows = await self.db.fetch("select pool, mint from paper_pool_runs where status = 'open' and version = $1", VERSION)
        slots = MAX_OPEN - len(open_rows)
        if slots <= 0:
            return
        seen_pools = {r["pool"] for r in await self.db.fetch("select pool from paper_pool_runs where version = $1", VERSION)}
        open_mints = {r["mint"] for r in open_rows}
        try:
            body = await asyncio.to_thread(
                portfolio._get, "/pools",
                {"page": 1, "page_size": 100, "sort_by": "pool_created_at:desc", "filter_by": "is_blacklisted=false"},
            )
        except Exception as err:
            log.warning("paper pool scan failed: %s", err)
            return
        now_ms = now.timestamp() * 1000
        picks = []
        for p in body.get("data") or []:
            age_min = (now_ms - _f(p.get("created_at"))) / 60_000
            x, y = p.get("token_x") or {}, p.get("token_y") or {}
            quote = QUOTES.get(y.get("address"))
            fee = _f((p.get("pool_config") or {}).get("base_fee_pct"))
            if (
                age_min > MAX_POOL_AGE_MIN or quote is None or fee < FEE_MIN_PCT
                or _f(p.get("tvl")) < MIN_TVL_USD or _f((p.get("volume") or {}).get("30m")) < MIN_VOLUME_30M_USD
                or not x.get("freeze_authority_disabled", True)
                or p["address"] in seen_pools or x.get("address") in open_mints or _f(p.get("current_price")) <= 0
            ):
                continue
            picks.append((p, age_min, quote, fee))
        picks.sort(key=lambda t: -_f((t[0].get("volume") or {}).get("30m")))
        for p, age_min, quote, fee in picks[:slots]:
            x = p["token_x"]
            await self.db.execute(
                """insert into paper_pool_runs (pool, name, mint, quote, base_fee_pct, opened_at, pool_age_min, status,
                     size_usd, sol_usd, entry_price, range_low, range_high, last_cum_fees, last_price, last_tvl,
                     checked_at, version, peak_tvl)
                   values ($1,$2,$3,$4,$5,$6,$7,'open',$8,$9,$10,$11,$12,$13,$10,$14,$6,$15,$14)""",
                p["address"], p.get("name") or "?", x["address"], quote, fee, now, age_min, SIZE_SOL * sol, sol,
                _f(p["current_price"]), RANGE_LOW, RANGE_HIGH, _f((p.get("cumulative_metrics") or {}).get("fees")),
                _f(p.get("tvl")), VERSION,
            )
            open_mints.add(x["address"])
            log.info("paper pool joined %s (fee %.1f%%, age %.0f min)", p.get("name"), fee, age_min)


def _summary(closed: list[dict[str, Any]]) -> dict[str, Any]:
    """Totals that a single lucky pool cannot hide: median, and the result without the best one and best three."""
    pnls = sorted(r["pnl_usd"] for r in closed)
    n = len(pnls)
    return {
        "closed": n,
        "pnl_usd": sum(pnls),
        "median_usd": (pnls[n // 2] if n % 2 else (pnls[n // 2 - 1] + pnls[n // 2]) / 2) if n else None,
        "without_best_usd": sum(pnls[:-1]) if n > 1 else None,
        "without_best3_usd": sum(pnls[:-3]) if n > 3 else None,
        "best_usd": pnls[-1] if n else None,
        "win_rate": sum(p > 0 for p in pnls) / n if n else None,
    }


async def report(db) -> dict[str, Any]:
    old = [dict(r) for r in await db.fetch("select pnl_usd from paper_pool_runs where status = 'closed' and version < $1", VERSION)]
    rows = [dict(r) for r in await db.fetch(
        "select * from paper_pool_runs where version = $1 order by opened_at desc limit 300", VERSION)]
    closed = [r for r in rows if r["status"] == "closed"]
    ms = lambda t: int(t.timestamp() * 1000) if t else None  # noqa: E731
    reasons: dict[str, int] = {}
    for r in closed:
        reasons[r["exit_reason"]] = reasons.get(r["exit_reason"], 0) + 1
    pnl = sum(r["pnl_usd"] for r in closed)
    create = sum(r["create_cost_usd"] or 0 for r in closed)
    orders = []
    for r in rows:
        ratio = (r["last_price"] or r["entry_price"]) / r["entry_price"]
        value = r["lp_value_usd"] if r["status"] == "closed" else r["size_usd"] * lp_value(ratio)
        orders.append({
            "id": r["id"], "pool": r["pool"], "name": r["name"], "quote": r["quote"], "base_fee_pct": r["base_fee_pct"],
            "status": r["status"], "exit_reason": r["exit_reason"], "pool_age_min": r["pool_age_min"],
            "size_usd": r["size_usd"], "fees_usd": r["fees_usd"], "lp_value_usd": value,
            "price_change_pct": (ratio - 1) * 100, "in_range_pct": (r["in_range_ticks"] / r["ticks"] * 100) if r["ticks"] else None,
            "last_tvl": r["last_tvl"], "costs_usd": r["costs_usd"], "create_cost_usd": r["create_cost_usd"],
            "pnl_usd": r["pnl_usd"] if r["status"] == "closed" else value + r["fees_usd"] - r["size_usd"],
            "opened_at": ms(r["opened_at"]), "closed_at": ms(r["closed_at"]),
        })
    return {
        "started_at": ms(min((r["opened_at"] for r in rows), default=None)),
        "params": {
            "size_sol": SIZE_SOL, "max_open": MAX_OPEN, "max_pool_age_min": MAX_POOL_AGE_MIN, "fee_min_pct": FEE_MIN_PCT,
            "min_tvl_usd": MIN_TVL_USD, "min_volume_30m_usd": MIN_VOLUME_30M_USD, "range_low": RANGE_LOW,
            "range_high": RANGE_HIGH, "stop_pct": STOP_PCT, "max_hold_h": MAX_HOLD_H, "create_cost_sol": CREATE_COST_SOL,
            "swap_cost_pct": SWAP_COST_PCT, "fees_dried_pct": FEES_DRIED_PCT, "tick_s": TICK_S,
            "max_share_pct": MAX_SHARE * 100, "pulled_tvl_pct": PULLED_TVL_FRAC * 100,
        },
        "counts": {"open": len(rows) - len(closed), "closed": len(closed), **reasons},
        "pnl_usd": pnl,
        "pnl_without_create_usd": pnl + create,
        "fees_usd": sum(r["fees_usd"] for r in closed),
        "capital_usd": sum(r["size_usd"] for r in closed),
        "win_rate": sum(r["pnl_usd"] > 0 for r in closed) / len(closed) if closed else None,
        "win_rate_without_create": sum(r["pnl_usd"] + (r["create_cost_usd"] or 0) > 0 for r in closed) / len(closed) if closed else None,
        "robust": _summary(closed),
        "version": VERSION,
        "previous": _summary(old) if old else None,
        "runs": orders,
    }
