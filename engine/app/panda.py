"""Paper test of the "Panda Strat": does screening hard, entering on a Supertrend break and providing one-sided SOL
across a very wide range actually pay?

Nothing is sent on chain. Every TICK_S the engine:
  * screens live pools against the strategy's own gates (market cap, volume, holders, concentration, insiders,
    bundling, fee/TVL, organic volume, security),
  * waits for the entry trigger on 15-minute candles -- price above Supertrend, having just flipped up, near the
    recent high -- and then opens a paper position of SIZE_SOL, quote only (SOL/USDC), spread evenly from the price
    down to RANGE_LOW_PCT across BINS bins,
  * follows it: as the price falls through the bins the quote converts to the token at each bin's price, and the
    position earns its share of the fees the pool actually collected,
  * exits on the strategy's own confluence (RSI(2) > 90 plus either a close above the upper Bollinger band or the
    first green MACD histogram bar), or when the position has nothing left to wait for.

Honest by construction: the pool's real prices and fees, a fee share that shrinks as other liquidity arrives, the
open-bin rent a creator never gets back, and the swap back out of whatever token is left. Where the strategy cannot
be copied exactly, the difference is named in APPROXIMATIONS and shown on the page.
"""

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any, Callable

from . import charts, config, indicators, portfolio
from .alerts import top10_pct
from .indicators import Candle
from .scoring import RISKY_FLAGS

log = logging.getLogger("panda")

TICK_S = 300
SIZE_SOL = 10.0  # the corpus' own minimum position size; smaller ones lose to the open-bin rent
MAX_OPEN = 6  # "diversifikasi ke >= 6 posisi"
RANGE_LOW_PCT = -90.0  # the -86%..-94% band, at its middle
BINS = 100
OPEN_BIN_COST_SOL = 0.45  # per 100 bins, non-refundable, from the corpus
EXIT_SWAP_COST_PCT = 1.0  # selling the token left at exit
TX_FEE_SOL = 0.0005
MAX_HOLD_H = 72
DEAD_VOLUME_USD = 10_000.0  # 24h volume under this = the flatline the corpus says not to wait out
NEAR_HIGH_PCT = 15.0  # "idealnya dekat ATH": within this much of the highest close on the 15m candles
CANDLE_HOURS = 24

# Gates from the corpus, section "Screening Token".
MIN_MARKET_CAP = 250_000.0
MIN_VOLUME_24H = 1_000_000.0
MIN_FEE_TVL_24H = 20.0
MIN_HOLDERS = 1_500
MAX_TOP10_PCT = 30.0
MAX_INSIDERS_PCT = 10.0
MAX_BUNDLERS_PCT = 60.0

APPROXIMATIONS = [
    "Candle 15 menit disusun dari candle 5 menit Meteora, karena Meteora tidak menyediakan 15 menit.",
    "Filter 'total fees > 30 SOL' dan 'volume 5 menit' tidak ada di data kita; diganti fee/TVL 24 jam > 20%.",
    "Phishing % (GMGN) tidak selalu tersedia; yang dipakai flag keamanan engine dan RugCheck.",
    "Biaya open bin dihitung penuh 0,45 SOL per 100 bin, seolah semua bin belum pernah dibuka orang lain.",
    "Pantau tiap 5 menit, lebih sering daripada ~30 menit di korpus; exit jadi lebih cepat tertangkap.",
]


def _f(v: Any) -> float | None:
    try:
        return float(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def to_candles(rows: list[dict[str, Any]]) -> list[Candle]:
    return [Candle(ts=int(r["ts"]), open=r["open"], high=r["high"], low=r["low"], close=r["close"], volume=r["volume"] or 0.0) for r in rows]


def to_15m(candles: list[Candle]) -> list[Candle]:
    """Three 5-minute candles make one 15-minute candle: open of the first, close of the last, the extremes and the
    summed volume between."""
    out: list[Candle] = []
    for i in range(0, len(candles) - 2, 3):
        group = candles[i : i + 3]
        out.append(Candle(
            ts=group[0].ts, open=group[0].open, high=max(c.high for c in group), low=min(c.low for c in group),
            close=group[-1].close, volume=sum(c.volume for c in group),
        ))
    return out


def screen(row: dict[str, Any]) -> tuple[bool, str]:
    """The strategy's first gate. Returns (passes, reason it failed)."""
    name = row.get("name") or ""
    quote = name.rsplit("-", 1)[-1].upper() if "-" in name else ""
    if quote not in ("SOL", "USDC"):
        return False, "bukan pasangan SOL/USDC"
    if not row.get("security"):
        return False, "data keamanan belum ada"
    if set(row.get("flags") or []) & RISKY_FLAGS:
        return False, "flag risiko"
    mc = _f(row.get("market_cap"))
    if mc is None or mc < MIN_MARKET_CAP:
        return False, f"market cap < ${MIN_MARKET_CAP:,.0f}"
    if (_f(row.get("volume_24h")) or 0) < MIN_VOLUME_24H:
        return False, f"volume 24j < ${MIN_VOLUME_24H:,.0f}"
    if (_f(row.get("fee_tvl_pct_24h")) or 0) < MIN_FEE_TVL_24H:
        return False, f"fee/TVL 24j < {MIN_FEE_TVL_24H:g}%"
    holders = _f(row.get("holders"))
    if holders is None or holders < MIN_HOLDERS:
        return False, f"holder < {MIN_HOLDERS}"
    top10 = top10_pct(row)
    if top10 is None or top10 > MAX_TOP10_PCT:
        return False, f"top-10 holder > {MAX_TOP10_PCT:g}%"
    insight = row.get("insights") or {}
    insiders = _f(insight.get("insiders_pct"))
    if insiders is not None and insiders > MAX_INSIDERS_PCT:
        return False, f"insider > {MAX_INSIDERS_PCT:g}%"
    bundlers = _f(insight.get("bundlers_pct"))
    if bundlers is not None and bundlers > MAX_BUNDLERS_PCT:
        return False, f"bundling > {MAX_BUNDLERS_PCT:g}%"
    # Organic volume: fees collected should match volume times the pool's own fee rate. Far below means the volume
    # did not really pay fees -- the wash-trading check from the corpus.
    fees, volume, base = _f(row.get("fees_24h")), _f(row.get("volume_24h")), _f(row.get("base_fee_pct"))
    if fees is not None and volume and base and fees < volume * base / 100 * 0.5:
        return False, "volume tidak organik (fee jauh di bawah volume x fee rate)"
    return True, ""


def entry_signal(c15: list[Candle]) -> tuple[bool, str]:
    """The trigger: price above a Supertrend that has just flipped up, and not far below the recent high."""
    if len(c15) < 30:
        return False, "candle 15m belum cukup"
    st = indicators.supertrend(c15)
    if not st or not st["up"]:
        return False, "harga di bawah Supertrend 15m"
    if not st["flipped_up"]:
        return False, "break Supertrend sudah lewat"
    high = max(c.close for c in c15)
    close = c15[-1].close
    if high > 0 and (high - close) / high * 100 > NEAR_HIGH_PCT:
        return False, f"jauh di bawah puncak ({(high - close) / high * 100:.0f}%)"
    return True, ""


def exit_signal(c15: list[Candle]) -> str | None:
    """The strategy's confluence: RSI(2) over 90 plus either a close above the upper band or the first green MACD
    histogram bar. Returns which pair fired."""
    closes = [c.close for c in c15]
    r = indicators.rsi(closes, 2)
    if r is None or r <= 90:
        return None
    bands = indicators.bollinger_bands(closes)
    if bands and closes[-1] > bands["upper"]:
        return "rsi2_bb"
    hist = indicators.macd_histogram(closes)
    if hist and len(hist) >= 2 and hist[-1] > 0 >= hist[-2]:
        return "rsi2_macd"
    return None


def position_value(size: float, ratio: float) -> tuple[float, float]:
    """(quote value, token value) of a one-sided quote position, per the bins it was spread over.

    Every bin starts with the same amount of quote. A bin is untouched while the price is above it; once the price
    falls through it, that bin holds the token it bought there, worth ratio/bin_price of what it paid."""
    low = 1 + RANGE_LOW_PCT / 100
    quote = token = 0.0
    for i in range(BINS):
        p = low + (1 - low) * (i + 0.5) / BINS  # bin prices as a fraction of the entry price
        if ratio > p:
            quote += 1.0  # price never came down to this bin
        else:
            token += ratio / p  # bought at p, now worth ratio
    per_bin = size / BINS
    return quote * per_bin, token * per_bin


class PandaPaper:
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
                log.exception("panda tick failed")
            await asyncio.sleep(TICK_S)

    async def step(self) -> None:
        now = datetime.now(timezone.utc)
        rows = self.rows()
        for r in await self.db.fetch("select * from paper_panda_runs where status = 'open'"):
            await self._tick(dict(r), rows.get(r["pool"]), now)
        await self._open_new(rows, now)

    async def _candles_15m(self, pool: str) -> list[Candle]:
        data = await charts.load_candles(self.db, pool, "5m", CANDLE_HOURS)
        return to_15m(to_candles(data.get("candles") or []))

    async def _tick(self, r: dict[str, Any], row: dict[str, Any] | None, now: datetime) -> None:
        try:
            pool = await asyncio.to_thread(portfolio._get, f"/pools/{r['pool']}", {})
        except Exception as err:
            log.warning("panda %s read failed: %s", r["name"], err)
            return
        price = _f(pool.get("current_price")) or 0.0
        tvl = _f(pool.get("tvl")) or 0.0
        cum = _f((pool.get("cumulative_metrics") or {}).get("fees")) or 0.0
        volume_24h = _f((pool.get("volume") or {}).get("24h")) or 0.0
        if price <= 0:
            await self._close(r, now, r["last_price"] or r["entry_price"], "vanished")
            return
        ratio = price / r["entry_price"]
        quote_usd, token_usd = position_value(r["size_usd"], ratio)
        value = quote_usd + token_usd
        in_range = ratio >= 1 + RANGE_LOW_PCT / 100
        earned = (cum - r["last_cum_fees"]) * value / (value + max(tvl, 0.0)) if in_range and cum > r["last_cum_fees"] else 0.0
        await self.db.execute(
            """update paper_panda_runs set last_cum_fees = $2, fees_usd = fees_usd + $3, last_price = $4,
                 last_tvl = $5, last_volume_24h = $6, ticks = ticks + 1, checked_at = $7,
                 min_ratio = least(min_ratio, $8) where id = $1""",
            r["id"], cum, earned, price, tvl, volume_24h, now, ratio,
        )
        r.update(fees_usd=r["fees_usd"] + earned, last_price=price)

        held_h = (now - r["opened_at"]).total_seconds() / 3600
        c15 = await self._candles_15m(r["pool"])
        if c15 and (reason := exit_signal(c15)):
            await self._close(r, now, price, reason)
        elif volume_24h < DEAD_VOLUME_USD:
            await self._close(r, now, price, "flatline")  # "if it flatlines, it means you're too late"
        elif held_h >= MAX_HOLD_H:
            await self._close(r, now, price, "time")

    async def _close(self, r: dict[str, Any], now: datetime, price: float, reason: str) -> None:
        ratio = price / r["entry_price"] if r["entry_price"] else 0.0
        quote_usd, token_usd = position_value(r["size_usd"], ratio)
        sol_usd = r["sol_usd"]
        costs = token_usd * EXIT_SWAP_COST_PCT / 100 + TX_FEE_SOL * sol_usd
        rent = OPEN_BIN_COST_SOL * (BINS / 100) * sol_usd
        pnl = quote_usd + token_usd + r["fees_usd"] - r["size_usd"] - costs - rent
        await self.db.execute(
            """update paper_panda_runs set status = 'closed', closed_at = $2, exit_reason = $3, lp_value_usd = $4,
                 token_value_usd = $5, costs_usd = $6, rent_usd = $7, pnl_usd = $8, last_price = $9 where id = $1""",
            r["id"], now, reason, quote_usd + token_usd, token_usd, costs, rent, pnl, price,
        )
        log.info("panda %s closed (%s): %+.2f USD, fee %.2f", r["name"], reason, pnl, r["fees_usd"])

    async def _open_new(self, rows: dict[str, dict[str, Any]], now: datetime) -> None:
        open_rows = await self.db.fetch("select pool, mint from paper_panda_runs where status = 'open'")
        slots = MAX_OPEN - len(open_rows)
        if slots <= 0:
            return
        open_mints = {r["mint"] for r in open_rows}
        open_pools = {r["pool"] for r in open_rows}
        sol = self.sol_usd()
        # Screen first (cheap, local), and only fetch candles for what survives.
        candidates = []
        for address, row in rows.items():
            if address in open_pools or (row.get("base_mint") or "") in open_mints:
                continue
            ok, _ = screen(row)
            if ok:
                candidates.append(row)
        candidates.sort(key=lambda r: -(_f(r.get("fee_tvl_pct_24h")) or 0))
        for row in candidates[:12]:
            if slots <= 0:
                break
            try:
                c15 = await self._candles_15m(row["address"])
            except Exception as err:
                log.warning("panda candles %s failed: %s", row.get("name"), err)
                continue
            ok, _ = entry_signal(c15)
            if not ok:
                continue
            price = _f(row.get("price")) or 0.0
            if price <= 0:
                continue
            await self.db.execute(
                """insert into paper_panda_runs (pool, name, mint, quote, opened_at, status, size_usd, sol_usd,
                     entry_price, range_low_pct, bins, last_cum_fees, last_price, last_tvl, min_ratio, checked_at)
                   values ($1,$2,$3,$4,$5,'open',$6,$7,$8,$9,$10,$11,$8,$12,1,$5)""",
                row["address"], row.get("name") or "?", row.get("base_mint") or "", (row.get("name") or "-").rsplit("-", 1)[-1],
                now, SIZE_SOL * sol, sol, price, RANGE_LOW_PCT, BINS,
                await self._pool_cum_fees(row["address"]), _f(row.get("tvl")) or 0.0,
            )
            open_mints.add(row.get("base_mint") or "")
            slots -= 1
            log.info("panda masuk %s di %.3e (fee/TVL %.0f%%)", row.get("name"), price, _f(row.get("fee_tvl_pct_24h")) or 0)

    async def _pool_cum_fees(self, address: str) -> float:
        try:
            pool = await asyncio.to_thread(portfolio._get, f"/pools/{address}", {})
            return _f((pool.get("cumulative_metrics") or {}).get("fees")) or 0.0
        except Exception:
            return 0.0


async def report(db, rows: dict[str, dict[str, Any]] | None = None) -> dict[str, Any]:
    runs = [dict(r) for r in await db.fetch("select * from paper_panda_runs order by opened_at desc limit 300")]
    closed = [r for r in runs if r["status"] == "closed"]
    ms = lambda t: int(t.timestamp() * 1000) if t else None  # noqa: E731
    reasons: dict[str, int] = {}
    for r in closed:
        reasons[r["exit_reason"]] = reasons.get(r["exit_reason"], 0) + 1
    pnl = sum(r["pnl_usd"] or 0 for r in closed)
    rent = sum(r["rent_usd"] or 0 for r in closed)
    # How many live pools clear each gate right now: the screening funnel the strategy calls 70% of the work.
    funnel: dict[str, int] = {}
    for row in (rows or {}).values():
        ok, why = screen(row)
        funnel["lolos" if ok else why] = funnel.get("lolos" if ok else why, 0) + 1
    out = []
    for r in runs:
        ratio = (r["last_price"] or r["entry_price"]) / r["entry_price"] if r["entry_price"] else 1.0
        quote_usd, token_usd = position_value(r["size_usd"], ratio)
        out.append({
            "id": r["id"], "pool": r["pool"], "name": r["name"], "quote": r["quote"], "status": r["status"],
            "exit_reason": r["exit_reason"], "size_usd": r["size_usd"], "fees_usd": r["fees_usd"],
            "value_usd": r["lp_value_usd"] if r["status"] == "closed" else quote_usd + token_usd,
            "token_value_usd": r["token_value_usd"] if r["status"] == "closed" else token_usd,
            "price_change_pct": (ratio - 1) * 100, "deepest_drop_pct": ((r["min_ratio"] or 1) - 1) * 100,
            "last_tvl": r["last_tvl"], "costs_usd": r["costs_usd"], "rent_usd": r["rent_usd"],
            "pnl_usd": r["pnl_usd"] if r["status"] == "closed" else quote_usd + token_usd + r["fees_usd"] - r["size_usd"],
            "opened_at": ms(r["opened_at"]), "closed_at": ms(r["closed_at"]),
        })
    return {
        "params": {
            "size_sol": SIZE_SOL, "max_open": MAX_OPEN, "range_low_pct": RANGE_LOW_PCT, "bins": BINS,
            "open_bin_cost_sol": OPEN_BIN_COST_SOL, "max_hold_h": MAX_HOLD_H, "min_market_cap": MIN_MARKET_CAP,
            "min_volume_24h": MIN_VOLUME_24H, "min_fee_tvl_24h": MIN_FEE_TVL_24H, "min_holders": MIN_HOLDERS,
            "max_top10_pct": MAX_TOP10_PCT, "near_high_pct": NEAR_HIGH_PCT,
        },
        "approximations": APPROXIMATIONS,
        "counts": {"open": len(runs) - len(closed), "closed": len(closed), **reasons},
        "pnl_usd": pnl,
        "pnl_without_rent_usd": pnl + rent,
        "fees_usd": sum(r["fees_usd"] for r in closed),
        "capital_usd": sum(r["size_usd"] for r in closed),
        "win_rate": (sum((r["pnl_usd"] or 0) > 0 for r in closed) / len(closed)) if closed else None,
        "screening_funnel": dict(sorted(funnel.items(), key=lambda kv: -kv[1])),
        "runs": out,
        "sol_usd": config.SOL_USD_FALLBACK,
    }
