"""Paper test of the "Panda Strat": does screening hard, entering on a Supertrend break and providing one-sided SOL
across a very wide range actually pay?

Nothing is sent on chain. Every TICK_S the engine:
  * screens live pools against the strategy's own gates (market cap, volume, holders, concentration, insiders,
    bundling, fee/TVL, organic volume, security),
  * waits for the entry trigger on 15-minute candles -- price above Supertrend, having just flipped up, near the
    recent high -- and then opens a paper position of SIZE_USD, quote only (SOL/USDC), spread evenly from the price
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
from .netpnl import _get_json
from .alerts import top10_pct
from .indicators import Candle
from .scoring import RISKY_FLAGS

log = logging.getLogger("panda")

TICK_S = 300
SIZE_USD = 100.0  # what the user is willing to risk per position while this is only a test
MAX_OPEN = 6  # "diversifikasi ke >= 6 posisi"
RANGE_LOW_PCT = -90.0  # the -86%..-94% band, at its middle
BINS = 100
# What a position really costs on Meteora, checked against the app's own cost dialog for a 100-bin position:
# 0.06 SOL position rent + 0.02 SOL extension, both REFUNDED on close, plus the transaction fees. The 0.45-0.5 SOL
# in the corpus is bin-array rent, which is charged only for bins nobody has opened before -- it does not apply to
# the busy pools this strategy screens for. It is charged here only when the engine's depth data says the range
# would create new arrays.
POSITION_RENT_SOL = 0.05740608  # SDK POSITION_FEE: locked while the position is open, returned on close
NEW_BIN_ARRAY_SOL = 0.07143744  # SDK BIN_ARRAY_FEE: per bin array actually created, not refunded
EXIT_SWAP_COST_PCT = 1.0  # selling the token left at exit
TX_FEE_SOL = 0.0005
MAX_HOLD_H = 72
# The exit is "keluar di bounce pertama" -- after the dump the position was opened to harvest. Entry and exit
# would otherwise fire together: the entry waits for a break above Supertrend near the high, which is exactly when
# RSI(2) is over 90 and the price sits on the upper band. The first five paper positions all closed within five
# minutes for that reason. So the confluence only counts once the price has actually fallen through part of the
# range, or the position has been held long enough for the dump to have happened.
MIN_DROP_BEFORE_EXIT_PCT = 3.0
MIN_HOLD_MIN = 60
DEAD_VOLUME_USD = 10_000.0  # 24h volume under this = the flatline the corpus says not to wait out
# The corpus gives the entry twice: "harga menembus ke atas Supertrend 15m" and, in the fullest write-up,
# "Entry: ATH. Bullish supertrend." So either qualifies: a break inside the last hour, or a price sitting at its
# high while the trend is already up. Demanding both would reject exactly the setup the strategy describes -- a
# pool riding its high hours after the break.
MAX_BARS_SINCE_BREAK = 4  # four 15m candles
AT_HIGH_PCT = 3.0  # "at ATH": this close to the highest close counts as an entry on its own
NEAR_HIGH_PCT = 15.0  # never enter further below the high than this, whichever trigger fired
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
    "Fee: hanya bin tempat harga berada yang dapat fee, jadi bagian kita = likuiditas kita per bin ÷ likuiditas pool di bin itu (dari data bin on-chain). Posisi yang dibuka sebelum 26/09 dihitung ulang dengan kedalaman pool saat ini.",
    "Sewa posisi 0,08 SOL dikunci saat posisi terbuka lalu dikembalikan, jadi tidak dihitung sebagai kerugian.",
    "Sewa bin array: 0,0714 SOL per array (SDK Meteora) yang belum ada di range posisi, dicek on-chain saat posisi dibuka. Range sampai -90% hampir selalu butuh array baru, karena jarang ada yang memasang likuiditas sejauh itu.",
    "Jumlah bin mengikuti bin step pool: sebanyak yang dibutuhkan untuk menjangkau -90% dari harga masuk.",
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
    high = max(c.close for c in c15)
    close = c15[-1].close
    gap = (high - close) / high * 100 if high > 0 else 100.0
    if gap > NEAR_HIGH_PCT:
        return False, f"jauh di bawah puncak ({gap:.0f}%)"
    bars = st.get("bars_since_flip")
    fresh_break = bars is not None and bars <= MAX_BARS_SINCE_BREAK
    if not fresh_break and gap > AT_HIGH_PCT:
        return False, f"break {bars} candle lalu dan {gap:.0f}% di bawah puncak"
    return True, ""


def entry_checklist(c15: list[Candle]) -> list[dict[str, Any]]:
    """The entry trigger as separate checks, for the page: which part holds, which does not, and the number."""
    if len(c15) < 30:
        return [{"key": "candles", "label": "Riwayat candle 15m cukup (≥30)", "ok": False, "detail": f"{len(c15)} candle"}]
    st = indicators.supertrend(c15) or {}
    high = max(c.close for c in c15)
    close = c15[-1].close
    gap = (high - close) / high * 100 if high > 0 else 100.0
    bars = st.get("bars_since_flip")
    fresh = bars is not None and bars <= MAX_BARS_SINCE_BREAK
    return [
        {"key": "supertrend", "label": "Harga di atas Supertrend 15m", "ok": bool(st.get("up")),
         "detail": "tren naik" if st.get("up") else "tren turun"},
        {"key": "near_high", "label": f"Tidak lebih dari {NEAR_HIGH_PCT:g}% di bawah puncak 24j", "ok": gap <= NEAR_HIGH_PCT,
         "detail": f"{gap:.1f}% di bawah puncak"},
        {"key": "trigger", "label": f"Baru tembus Supertrend (≤{MAX_BARS_SINCE_BREAK} candle) atau di puncak (≤{AT_HIGH_PCT:g}%)",
         "ok": fresh or gap <= AT_HIGH_PCT,
         "detail": ("tembus " + (f"{bars} candle lalu" if bars is not None else "belum ada")) + f" · {gap:.1f}% dari puncak"},
    ]


def pool_card(row: dict[str, Any], why: str) -> dict[str, Any]:
    """A pool that failed the screen, in the same shape as a candidate, with the failed gate as its only check."""
    flags = [f for f in (row.get("flags") or []) if f in RISKY_FLAGS]
    return {
        "address": row["address"], "name": row.get("name"), "price": _f(row.get("price")),
        "market_cap": _f(row.get("market_cap")), "volume_24h": _f(row.get("volume_24h")), "tvl": _f(row.get("tvl")),
        "fee_tvl_pct_24h": _f(row.get("fee_tvl_pct_24h")), "holders": _f(row.get("holders")),
        "top10_pct": top10_pct(row), "change_pct_1h": _f(row.get("change_pct_1h")),
        "checks": [{"key": "gate", "label": why, "ok": False, "detail": ", ".join(flags) if flags else "gugur di seleksi"}],
        "entry_ok": False, "held": False, "rejected": True,
    }


# The last screening pass: pools that cleared every gate, with the entry checklist, for the funnel page.
LAST_CANDIDATES: dict[str, Any] = {"checked_at": None, "pools": []}


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


def fee_share(size_usd: float, bins: int, row: dict[str, Any] | None, tvl: float) -> float:
    """Our share of the fees a swap pays: only the bin the price is in earns, so it is our liquidity in that bin
    over the pool's liquidity in that bin. Ours is the position spread evenly over its bins; the pool's comes from
    the on-chain bin depth, or TVL over 70 bins (one array) when the pool has no depth data."""
    ours = size_usd / max(bins, 1)
    depth = (row or {}).get("depth") or {}
    pool_bin = depth.get("active_bin_usd") or depth.get("avg_nonempty_bin_usd") or (max(tvl, 0.0) / 70)
    return ours / (ours + pool_bin) if ours + pool_bin > 0 else 0.0


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

    async def _arrays(self, pool: str) -> dict[str, Any] | None:
        """Bins and bin arrays the range needs, and how many arrays do not exist yet (ingestor, on chain)."""
        url = f"{config.CLAIM_SERVER_URL}/bin-arrays?pool={pool}&low_pct={RANGE_LOW_PCT}"
        try:
            return await asyncio.to_thread(_get_json, url)
        except Exception as err:
            log.warning("panda bin arrays for %s: %s", pool[:6], err)
            return None

    async def _fix_rent(self) -> None:
        """Runs from before the on-chain check had no rent: check their pools now and charge it (for closed runs,
        taken off the stored result). Arrays created since entry would make this an undercount, not an overcount."""
        for r in await self.db.fetch("select * from paper_panda_runs where not rent_checked"):
            info = await self._arrays(r["pool"])
            if info is None:
                continue
            new = int(info.get("new_arrays") or 0)
            rent = new * NEW_BIN_ARRAY_SOL * (r["sol_usd"] or self.sol_usd())
            if r["status"] == "closed":
                await self.db.execute(
                    """update paper_panda_runs set new_arrays = $2, bins = $3, rent_usd = $4,
                         pnl_usd = pnl_usd - $4 + coalesce(rent_usd, 0), rent_checked = true where id = $1""",
                    r["id"], new, int(info.get("bins") or r["bins"]), rent,
                )
            else:
                await self.db.execute(
                    "update paper_panda_runs set new_arrays = $2, bins = $3, rent_checked = true where id = $1",
                    r["id"], new, int(info.get("bins") or r["bins"]),
                )
            log.info("panda %s: %d new bin array(s), rent %.2f USD", r["name"], new, rent)

    async def _fix_fees(self) -> None:
        """Runs from before the per-bin fee share (2026-09-26) were credited value/(value+TVL), as if the whole
        position sat in the active bin. Rescale their fees by new share / old share, measured on the pool now,
        and take the difference off closed results. An estimate: the pool's depth at the time is not kept."""
        rows = self.rows()
        for r in await self.db.fetch("select * from paper_panda_runs where fee_model < 2"):
            tvl = r["last_tvl"] or 0.0
            old = r["size_usd"] / (r["size_usd"] + tvl) if tvl > 0 else 0.0
            new = fee_share(r["size_usd"], r["bins"] or BINS, rows.get(r["pool"]), tvl)
            fees = r["fees_usd"] * (new / old) if old > 0 else r["fees_usd"]
            await self.db.execute(
                """update paper_panda_runs set fees_usd = $2, pnl_usd = case when status = 'closed'
                     then pnl_usd - $3 + $2 else pnl_usd end, fee_model = 2 where id = $1""",
                r["id"], fees, r["fees_usd"],
            )
            log.info("panda %s fees %.2f -> %.2f (share %.4f -> %.4f)", r["name"], r["fees_usd"], fees, old, new)

    async def step(self) -> None:
        now = datetime.now(timezone.utc)
        await self._fix_rent()
        await self._fix_fees()
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
        # The range runs from the entry price down: above the entry (a pump) or under its floor it earns nothing.
        in_range = 1 + RANGE_LOW_PCT / 100 <= ratio <= 1.0
        share = fee_share(r["size_usd"], r["bins"] or BINS, row, tvl)
        earned = (cum - r["last_cum_fees"]) * share if in_range and cum > r["last_cum_fees"] else 0.0
        await self.db.execute(
            """update paper_panda_runs set last_cum_fees = $2, fees_usd = fees_usd + $3, last_price = $4,
                 last_tvl = $5, last_volume_24h = $6, ticks = ticks + 1, checked_at = $7,
                 min_ratio = least(min_ratio, $8) where id = $1""",
            r["id"], cum, earned, price, tvl, volume_24h, now, ratio,
        )
        r.update(fees_usd=r["fees_usd"] + earned, last_price=price)

        held_h = (now - r["opened_at"]).total_seconds() / 3600
        c15 = await self._candles_15m(r["pool"])
        dropped = (1 - min(r["min_ratio"], ratio)) * 100 >= MIN_DROP_BEFORE_EXIT_PCT
        ready = dropped or held_h * 60 >= MIN_HOLD_MIN
        if ready and c15 and (reason := exit_signal(c15)):
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
        rent = (r["new_arrays"] or 0) * NEW_BIN_ARRAY_SOL * sol_usd  # 0 when the bins were already open
        pnl = quote_usd + token_usd + r["fees_usd"] - r["size_usd"] - costs - rent
        await self.db.execute(
            """update paper_panda_runs set status = 'closed', closed_at = $2, exit_reason = $3, lp_value_usd = $4,
                 token_value_usd = $5, costs_usd = $6, rent_usd = $7, pnl_usd = $8, last_price = $9 where id = $1""",
            r["id"], now, reason, quote_usd + token_usd, token_usd, costs, rent, pnl, price,
        )
        log.info("panda %s closed (%s): %+.2f USD, fee %.2f", r["name"], reason, pnl, r["fees_usd"])

    async def _open_new(self, rows: dict[str, dict[str, Any]], now: datetime) -> None:
        open_rows = await self.db.fetch("select pool, mint from paper_panda_runs where status = 'open'")
        slots = MAX_OPEN - len(open_rows)  # full slots still refresh the checklist below; they only block entries
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
        # Every pool that passes the screen, held ones included, with its entry checklist for the page.
        shown = []
        for address, row in rows.items():
            if screen(row)[0]:
                shown.append(row)
        report_rows = []
        for row in sorted(shown, key=lambda r: -(_f(r.get("fee_tvl_pct_24h")) or 0))[:20]:
            try:
                checks = entry_checklist(await self._candles_15m(row["address"]))
            except Exception as err:
                checks = [{"key": "candles", "label": "Candle 15m terbaca", "ok": False, "detail": str(err)[:60]}]
            held = row["address"] in open_pools or (row.get("base_mint") or "") in open_mints
            report_rows.append({
                "address": row["address"], "name": row.get("name"), "price": _f(row.get("price")),
                "market_cap": _f(row.get("market_cap")), "volume_24h": _f(row.get("volume_24h")), "tvl": _f(row.get("tvl")),
                "fee_tvl_pct_24h": _f(row.get("fee_tvl_pct_24h")), "holders": _f(row.get("holders")),
                "top10_pct": top10_pct(row), "change_pct_1h": _f(row.get("change_pct_1h")),
                "checks": checks, "entry_ok": all(c["ok"] for c in checks), "held": held,
            })
        LAST_CANDIDATES.update(checked_at=int(now.timestamp() * 1000), pools=report_rows, slots=slots)
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
                     entry_price, range_low_pct, bins, last_cum_fees, last_price, last_tvl, min_ratio, checked_at, fee_model)
                   values ($1,$2,$3,$4,$5,'open',$6,$7,$8,$9,$10,$11,$8,$12,1,$5,2)""",
                row["address"], row.get("name") or "?", row.get("base_mint") or "", (row.get("name") or "-").rsplit("-", 1)[-1],
                now, SIZE_USD, sol, price, RANGE_LOW_PCT, BINS,
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
    rejected: dict[str, list[dict[str, Any]]] = {}
    for row in (rows or {}).values():
        ok, why = screen(row)
        funnel["lolos" if ok else why] = funnel.get("lolos" if ok else why, 0) + 1
        if not ok:
            rejected.setdefault(why, []).append(pool_card(row, why))
    for why in rejected:  # the busiest first, and not every one of hundreds
        rejected[why] = sorted(rejected[why], key=lambda p: -(p["volume_24h"] or 0))[:30]
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
            "mint": r["mint"], "entry_price": r["entry_price"], "last_price": r["last_price"],
            "range_low_pct": r["range_low_pct"], "bins": r["bins"], "sol_usd": r["sol_usd"],
            "checked_at": ms(r["checked_at"]),
        })
    return {
        "params": {
            "size_usd": SIZE_USD, "max_open": MAX_OPEN, "range_low_pct": RANGE_LOW_PCT, "bins": BINS,
            "position_rent_sol": POSITION_RENT_SOL, "new_bin_array_sol": NEW_BIN_ARRAY_SOL,
            "max_hold_h": MAX_HOLD_H, "min_market_cap": MIN_MARKET_CAP,
            "min_volume_24h": MIN_VOLUME_24H, "min_fee_tvl_24h": MIN_FEE_TVL_24H, "min_holders": MIN_HOLDERS,
            "max_top10_pct": MAX_TOP10_PCT, "near_high_pct": NEAR_HIGH_PCT,
            "min_drop_before_exit_pct": MIN_DROP_BEFORE_EXIT_PCT, "min_hold_min": MIN_HOLD_MIN,
        },
        "approximations": APPROXIMATIONS,
        "counts": {"open": len(runs) - len(closed), "closed": len(closed), **reasons},
        "pnl_usd": pnl,
        "pnl_without_rent_usd": pnl + rent,
        "rent_locked_usd": POSITION_RENT_SOL * (runs[0]["sol_usd"] if runs else 0),
        "fees_usd": sum(r["fees_usd"] for r in closed),
        "capital_usd": sum(r["size_usd"] for r in closed),
        "win_rate": (sum((r["pnl_usd"] or 0) > 0 for r in closed) / len(closed)) if closed else None,
        "screening_funnel": dict(sorted(funnel.items(), key=lambda kv: -kv[1])),
        "candidates": LAST_CANDIDATES,
        "rejected": rejected,
        "runs": out,
        "sol_usd": config.SOL_USD_FALLBACK,
    }
