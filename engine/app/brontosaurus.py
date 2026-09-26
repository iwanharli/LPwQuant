"""Paper test "Brontosaurus": the fee-farming style of the leaderboard's 96%-win-rate wallet (8ryc…, 25,979 positions,
+$371k lifetime). Its money is all fees (+$93.6k) against price loss (-$36.1k) over 1,013 positions studied on
2026-09-26: wide ranges on high-fee memecoin/SOL pools, held for about twelve hours.

Every TICK_S:
  * screen: SOL pair, base fee >= MIN_BASE_FEE_PCT, bin step >= MIN_BIN_STEP, busy and fee-rich, no risky flag, not
    pumping, not a token launched in the last day;
  * open: SIZE_USD, spot (equal value per bin) over BINS bins centred on the price, at most MAX_OPEN at once;
  * fees: our liquidity in the active bin over the pool's in that bin (on-chain depth, else TVL over 70 bins), times
    the pool's fees since the last tick, only while the price is in range;
  * exit like the wallet: from TARGET_HOLD_H on, close once in net profit; keep a losing position until it recovers,
    until MAX_HOLD_H, or until the pool's liquidity is pulled. No stop-loss.

Costs: half the capital is swapped into the token at entry and what token is left is sold at exit (the pool's fee
plus 0.3% impact each way), network fees, and bin-array rent for arrays under the range that do not exist yet.
"""

import asyncio
import json
import logging
import math
import urllib.request
from datetime import datetime, timezone
from typing import Any, Callable

from . import config, portfolio
from .backtest import LpPosition
from .scoring import RISKY_FLAGS

log = logging.getLogger("brontosaurus")

TICK_S = 300
SIZE_USD = 100.0
MAX_OPEN = 10
BINS = 70
MIN_BASE_FEE_PCT = 1.0
MIN_BIN_STEP = 80
MIN_VOLUME_24H = 300_000.0
MIN_FEE_TVL_24H = 20.0
MIN_TVL = 20_000.0
MAX_PUMP_1H = 30.0
MIN_TOKEN_AGE_H = 24.0
TARGET_HOLD_H = 12.0
MAX_HOLD_H = 72.0
PULLED_FRAC = 0.3
IMPACT_PCT = 0.3
TX_FEE_SOL = 0.0006
BIN_ARRAY_SOL = 0.07143744


def _f(v: Any) -> float | None:
    try:
        return None if v is None else float(v)
    except (TypeError, ValueError):
        return None


def screen(row: dict[str, Any]) -> tuple[bool, str]:
    name = row.get("name") or ""
    if not name.upper().endswith("-SOL"):
        return False, "bukan pasangan SOL"
    if not row.get("security"):
        return False, "data keamanan belum ada"
    if set(row.get("flags") or []) & RISKY_FLAGS:
        return False, "flag risiko"
    if (_f(row.get("base_fee_pct")) or 0) < MIN_BASE_FEE_PCT:
        return False, f"fee dasar < {MIN_BASE_FEE_PCT:g}%"
    if (row.get("bin_step") or 0) < MIN_BIN_STEP:
        return False, f"bin step < {MIN_BIN_STEP}"
    if (_f(row.get("tvl")) or 0) < MIN_TVL:
        return False, f"TVL < ${MIN_TVL:,.0f}"
    if (_f(row.get("volume_24h")) or 0) < MIN_VOLUME_24H:
        return False, f"volume 24j < ${MIN_VOLUME_24H:,.0f}"
    if (_f(row.get("fee_tvl_pct_24h")) or 0) < MIN_FEE_TVL_24H:
        return False, f"fee/TVL 24j < {MIN_FEE_TVL_24H:g}%"
    if (_f(row.get("change_pct_1h")) or 0) >= MAX_PUMP_1H:
        return False, "sedang pump"
    age = _f(row.get("token_age_hours"))
    if age is not None and age < MIN_TOKEN_AGE_H:
        return False, "token < 24 jam"
    return True, ""


def _lp(entry_price: float, bin_step: int) -> LpPosition:
    below = BINS // 2
    return LpPosition(p0=entry_price, r=1 + bin_step / 10_000, a=below, b=BINS - below - 1, v=SIZE_USD / BINS)


def _fee_share(row: dict[str, Any] | None, tvl: float) -> float:
    ours = SIZE_USD / BINS
    depth = (row or {}).get("depth") or {}
    pool_bin = depth.get("active_bin_usd") or depth.get("avg_nonempty_bin_usd") or (max(tvl, 0.0) / 70)
    return ours / (ours + pool_bin) if ours + pool_bin > 0 else 0.0


def _new_arrays(pool: str, bin_step: int) -> int:
    """Bin arrays under the range (active bin down to its low end) that do not exist yet. Blocking."""
    low_pct = ((1 + bin_step / 10_000) ** -(BINS // 2) - 1) * 100
    url = f"{config.CLAIM_SERVER_URL}/bin-arrays?pool={pool}&low_pct={low_pct:.4f}"
    try:
        with urllib.request.urlopen(url, timeout=20) as res:
            return int(json.load(res).get("new_arrays") or 0)
    except Exception:
        return 0


class Brontosaurus:
    def __init__(self, db, rows: Callable[[], dict[str, dict[str, Any]]], sol_usd: Callable[[], float]) -> None:
        self.db = db
        self.rows = rows
        self.sol_usd = sol_usd

    async def run(self) -> None:
        while True:
            try:
                await self.step()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("brontosaurus tick failed")
            await asyncio.sleep(TICK_S)

    async def step(self) -> None:
        now = datetime.now(timezone.utc)
        rows = self.rows()
        for r in await self.db.fetch("select * from paper_bronto_runs where status = 'open'"):
            await self._tick(dict(r), rows.get(r["pool"]), now)
        await self._open_new(rows, now)

    async def _tick(self, r: dict[str, Any], row: dict[str, Any] | None, now: datetime) -> None:
        try:
            pool = await asyncio.to_thread(portfolio._get, f"/pools/{r['pool']}", {})
        except Exception as err:
            log.info("bronto %s read failed: %s", r["name"], err)
            return
        price = _f(pool.get("current_price")) or 0.0
        tvl = _f(pool.get("tvl")) or 0.0
        cum = _f((pool.get("cumulative_metrics") or {}).get("fees")) or 0.0
        if price <= 0:
            await self._close(r, now, r["last_price"] or r["entry_price"], "vanished")
            return
        lp = _lp(r["entry_price"], r["bin_step"])
        earned = (cum - r["last_cum_fees"]) * _fee_share(row, tvl) if lp.in_range(price) and cum > r["last_cum_fees"] else 0.0
        peak = max(r["peak_tvl"] or 0.0, tvl)
        await self.db.execute(
            """update paper_bronto_runs set last_cum_fees = $2, fees_usd = fees_usd + $3, last_price = $4, last_tvl = $5,
                 peak_tvl = $6, checked_at = $7 where id = $1""",
            r["id"], cum, earned, price, tvl, peak, now,
        )
        r.update(fees_usd=r["fees_usd"] + earned, last_price=price)
        held_h = (now - r["opened_at"]).total_seconds() / 3600
        net = self._net(r, price)
        if peak > 0 and tvl < peak * PULLED_FRAC:
            await self._close(r, now, price, "pulled")
        elif held_h >= TARGET_HOLD_H and net > 0:
            await self._close(r, now, price, "target")
        elif held_h >= MAX_HOLD_H:
            await self._close(r, now, price, "time")

    def _net(self, r: dict[str, Any], price: float) -> float:
        """Result if closed now: position value + fees - capital - costs to date - selling the token left."""
        lp = _lp(r["entry_price"], r["bin_step"])
        exit_cost = lp.base_value(price) * ((r["base_fee_pct"] or 0) + IMPACT_PCT) / 100
        return lp.value(price) + r["fees_usd"] - SIZE_USD - (r["entry_cost_usd"] or 0) - exit_cost

    async def _close(self, r: dict[str, Any], now: datetime, price: float, reason: str) -> None:
        lp = _lp(r["entry_price"], r["bin_step"])
        exit_cost = lp.base_value(price) * ((r["base_fee_pct"] or 0) + IMPACT_PCT) / 100
        pnl = self._net(r, price)
        await self.db.execute(
            """update paper_bronto_runs set status = 'closed', closed_at = $2, exit_reason = $3, lp_value_usd = $4,
                 exit_cost_usd = $5, pnl_usd = $6, last_price = $7 where id = $1""",
            r["id"], now, reason, lp.value(price), exit_cost, pnl, price,
        )
        log.info("bronto %s closed (%s): %+.2f USD, fees %.2f", r["name"], reason, pnl, r["fees_usd"])

    async def _open_new(self, rows: dict[str, dict[str, Any]], now: datetime) -> None:
        open_rows = await self.db.fetch("select pool, mint from paper_bronto_runs where status = 'open'")
        slots = MAX_OPEN - len(open_rows)
        if slots <= 0:
            return
        held = {r["pool"] for r in open_rows} | {r["mint"] for r in open_rows}
        recent = {r["pool"] for r in await self.db.fetch(
            "select pool from paper_bronto_runs where opened_at > now() - interval '12 hours'")}
        picks = [row for row in rows.values() if screen(row)[0]
                 and row["address"] not in held and (row.get("base_mint") or "") not in held and row["address"] not in recent]
        picks.sort(key=lambda r: -(_f(r.get("fee_tvl_pct_24h")) or 0))
        sol = self.sol_usd()
        for row in picks[:slots]:
            price = _f(row.get("price")) or 0.0
            if price <= 0:
                continue
            try:
                pool = await asyncio.to_thread(portfolio._get, f"/pools/{row['address']}", {})
            except Exception:
                continue
            fee = _f(row.get("base_fee_pct")) or 0.0
            arrays = await asyncio.to_thread(_new_arrays, row["address"], row["bin_step"])
            # Half the capital becomes the token (spot, centred): that swap pays the pool fee plus impact.
            entry_cost = SIZE_USD / 2 * (fee + IMPACT_PCT) / 100 + TX_FEE_SOL * sol + arrays * BIN_ARRAY_SOL * sol
            await self.db.execute(
                """insert into paper_bronto_runs (pool, name, mint, opened_at, status, size_usd, entry_price, bin_step,
                     base_fee_pct, last_cum_fees, last_price, last_tvl, peak_tvl, new_arrays, entry_cost_usd, checked_at)
                   values ($1,$2,$3,$4,'open',$5,$6,$7,$8,$9,$6,$10,$10,$11,$12,$4)""",
                row["address"], row.get("name") or "?", row.get("base_mint") or "", now, SIZE_USD, price, row["bin_step"],
                fee, _f((pool.get("cumulative_metrics") or {}).get("fees")) or 0.0, _f(row.get("tvl")) or 0.0,
                arrays, entry_cost,
            )
            log.info("bronto opened %s (fee %.1f%%, bin step %d, %d new arrays)", row.get("name"), fee, row["bin_step"], arrays)


async def report(db, rows: dict[str, dict[str, Any]] | None = None) -> dict[str, Any]:
    runs = [dict(r) for r in await db.fetch("select * from paper_bronto_runs order by opened_at desc limit 300")]
    ms = lambda t: int(t.timestamp() * 1000) if t else None  # noqa: E731
    closed = [r for r in runs if r["status"] == "closed"]
    funnel: dict[str, int] = {}
    candidates = []
    for row in (rows or {}).values():
        ok, why = screen(row)
        funnel["lolos" if ok else why] = funnel.get("lolos" if ok else why, 0) + 1
        if ok:
            candidates.append({
                "address": row["address"], "name": row.get("name"), "price": row.get("price"),
                "market_cap": row.get("market_cap"), "volume_24h": row.get("volume_24h"), "tvl": row.get("tvl"),
                "fee_tvl_pct_24h": row.get("fee_tvl_pct_24h"), "holders": row.get("holders"),
                "top10_pct": (row.get("security") or {}).get("top10_pct"), "change_pct_1h": row.get("change_pct_1h"),
                "checks": [
                    {"key": "fee", "label": f"Fee dasar {row.get('base_fee_pct')}% · bin step {row.get('bin_step')}", "ok": True, "detail": "pool fee tinggi, range lebar"},
                    {"key": "busy", "label": "Ramai dan fee kaya", "ok": True, "detail": f"fee/TVL {row.get('fee_tvl_pct_24h') or 0:.0f}%"},
                ],
                "entry_ok": True, "held": False,
            })
    candidates.sort(key=lambda c: -(c["fee_tvl_pct_24h"] or 0))
    out = []
    for r in runs:
        lp = _lp(r["entry_price"], r["bin_step"])
        price = r["last_price"] or r["entry_price"]
        value = lp.value(price)
        running = value + r["fees_usd"] - SIZE_USD - (r["entry_cost_usd"] or 0)
        out.append({
            "id": r["id"], "pool": r["pool"], "name": r["name"], "status": r["status"], "exit_reason": r["exit_reason"],
            "entry_price": r["entry_price"], "last_price": price,
            "size_usd": r["size_usd"], "fees_usd": r["fees_usd"],
            "value_usd": r["lp_value_usd"] if r["status"] == "closed" else value,
            "price_change_pct": (price / r["entry_price"] - 1) * 100,
            "in_range": lp.in_range(price),
            "costs_usd": (r["entry_cost_usd"] or 0) + (r["exit_cost_usd"] or 0),
            "pnl_usd": r["pnl_usd"] if r["status"] == "closed" else running,
            "bin_step": r["bin_step"], "base_fee_pct": r["base_fee_pct"], "new_arrays": r["new_arrays"],
            "range_low_pct": ((1 + r["bin_step"] / 10_000) ** -(BINS // 2) - 1) * 100,
            "range_high_pct": ((1 + r["bin_step"] / 10_000) ** (BINS - BINS // 2 - 1) - 1) * 100,
            "opened_at": ms(r["opened_at"]), "closed_at": ms(r["closed_at"]), "checked_at": ms(r["checked_at"]),
        })
    return {
        "params": {"size_usd": SIZE_USD, "max_open": MAX_OPEN, "bins": BINS, "min_base_fee_pct": MIN_BASE_FEE_PCT,
                   "min_bin_step": MIN_BIN_STEP, "min_volume_24h": MIN_VOLUME_24H, "min_fee_tvl_24h": MIN_FEE_TVL_24H,
                   "min_tvl": MIN_TVL, "target_hold_h": TARGET_HOLD_H, "max_hold_h": MAX_HOLD_H, "tick_s": TICK_S},
        "counts": {"open": len(runs) - len(closed), "closed": len(closed)},
        "pnl_usd": sum(r["pnl_usd"] or 0 for r in closed),
        "fees_usd": sum(r["fees_usd"] for r in closed),
        "win_rate": sum((r["pnl_usd"] or 0) > 0 for r in closed) / len(closed) if closed else None,
        "screening_funnel": dict(sorted(funnel.items(), key=lambda kv: -kv[1])),
        "candidates": {"checked_at": None, "pools": candidates[:25]},
        "runs": out,
    }
