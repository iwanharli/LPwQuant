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

from . import lp_leaders, paper_phases, portfolio

log = logging.getLogger("copy_paper")

TICK_S = 120
FOLLOW = 5
SIZE_USD = 100.0
FRESH_MIN = 30
TX_FEE_SOL = 0.0006  # open, add, remove, close
EXIT_SWAP_PCT = 0.3  # selling the token part left at exit, as % of the position
# Phase 2: copy a wallet only while copying it pays. Phase 1 made +$659 before costs and lost -$611 after them:
# fixed costs on positions held minutes (one wallet opened 2,036 positions). Judged on the wallet's last
# TRACK_N closed copies; a wallet with fewer than TRACK_MIN is still tried, so new leaders get a chance.
TRACK_N = 30
TRACK_MIN = 10
MIN_MEDIAN_HOLD_H = 2.0
# Phase 3: new wallets are judged after 5 copies, and a copy is cut at STOP_PCT (phase 2 had no stop: SEALS -31%).
TRACK_MIN_P3 = 5
STOP_PCT = -15.0

# Two copy tests side by side, each in its own tables: "top" follows the leaderboard's top wallets by dollars made in
# 7 days (big, frequent traders); "small" follows small-capital wallets that make a wide margin per position and hold
# for hours, where a $100 copy's fixed costs (~$0.37) are a small part of the result. variant -> (table prefix, phase key).
VARIANTS: dict[str, tuple[str, str]] = {"top": ("paper_copy", "copy"), "small": ("paper_copy_small", "copy_small")}
SMALL_FOLLOW = 10
SMALL_MAX_DEPOSIT = 300.0
SMALL_MIN_MEDIAN_PCT = 1.0
SMALL_MIN_HOLD_H = 6.0
# Copy LP Kecil phase 2: a position already this far down when we first see it is not copied (phase 1 joined UP,
# SANTA and Frank at -4..-7%; Frank hit the stop twelve minutes later).
SMALL_MAX_ENTRY_PCT = -3.0
# Copy LP (top wallets) stopped taking new copies 2026-10-20: -$1,379 / -$1 / -$406 over three phases. Open copies
# still close at the wallet's result.
TOP_ACCEPTING = False
# Copy LP Kecil phase 3 (last): a wallet is copied for real only once its last PROVE_N copies of ours made money
# together. Until then every position it opens is still copied, as a shadow (shadow = true): tracked the same way
# but left out of the results, so a wallet earns its place on our own record rather than the leaderboard's.
PROVE_N = 20
# Open copies are re-marked this often between full ticks, so the -15% stop fires near -15% and not two minutes later
# (the first stops landed at -17..-18%). One Meteora call per wallet and pool with an open copy.
STOP_CHECK_S = 30


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


def small_fit(l: dict[str, Any]) -> bool:
    """A small-capital wallet worth copying with $100: small positions, a wide median margin, long holds, profitable
    without its three best positions and over its lifetime, and still active this week."""
    return ((l.get("deposit_median_usd") or 1e9) <= SMALL_MAX_DEPOSIT
            and (l.get("median_pct") or 0) >= SMALL_MIN_MEDIAN_PCT
            and (l.get("hold_median_h") or 0) >= SMALL_MIN_HOLD_H
            and (l.get("without_best3_usd") or 0) > 0
            and (l.get("lifetime_pnl_usd") or 0) > 0
            and (l.get("positions_7d") or 0) > 0)


async def followed(db, variant: str = "top") -> list[dict[str, Any]]:
    rep = await lp_leaders.report(db)
    if variant == "small":
        picks = [l for l in rep["leaders"] if small_fit(l)]
        picks.sort(key=lambda l: -(l.get("median_pct") or 0))
        return picks[:SMALL_FOLLOW]
    return [l for l in rep["leaders"] if l["meets"]][:FOLLOW]


async def eligible(db, wallet: str, variant: str = "top") -> tuple[bool, str]:
    """Whether the top-wallet test copies this wallet (phase 2 on): its last copies held long enough and did not lose.
    The small-wallet test is chosen on those terms already, so it copies every wallet it follows."""
    if variant == "small":
        if paper_phases.current("copy_small") < 3:
            return True, ""
        rows = await db.fetch(
            """select pnl_usd from paper_copy_small_runs where wallet = $1 and status = 'closed'
               order by closed_at desc limit $2""", wallet, PROVE_N)
        if len(rows) < PROVE_N:
            return False, f"belum terbukti ({len(rows)}/{PROVE_N} tiruan)"
        total = sum(r["pnl_usd"] or 0 for r in rows)
        if total <= 0:
            return False, f"{PROVE_N} tiruan terakhir rugi (${total:,.2f})"
        return True, f"{PROVE_N} tiruan terakhir +${total:,.2f}"
    if paper_phases.current("copy") < 2:
        return True, ""
    rows = await db.fetch(
        """select pnl_usd, extract(epoch from closed_at - opened_at) / 3600 as h from paper_copy_runs
           where wallet = $1 and status = 'closed' order by closed_at desc limit $2""", wallet, TRACK_N)
    if len(rows) < (TRACK_MIN_P3 if paper_phases.current("copy") >= 3 else TRACK_MIN):
        return True, "baru, masih dicoba"
    holds = sorted(float(r["h"] or 0) for r in rows)
    median = holds[len(holds) // 2]
    if median < MIN_MEDIAN_HOLD_H:
        return False, f"posisi terlalu pendek (median {median:.1f} jam)"
    total = sum(r["pnl_usd"] or 0 for r in rows)
    if total < 0:
        return False, f"tiruan terakhir rugi (${total:,.2f})"
    return True, ""


class CopyPaper:
    def __init__(self, db, sol_usd: Callable[[], float], variant: str = "top") -> None:
        self.db = db
        self.sol_usd = sol_usd
        self.variant = variant
        self.t, self.phase_key = VARIANTS[variant]

    def _stops(self, r: dict[str, Any] | None = None) -> bool:
        """Whether the -15% stop applies: on in the small test and from the top test's phase 3, and only to copies
        opened under those rules (an older copy keeps the rules it was opened with)."""
        on = self.variant == "small" or paper_phases.current("copy") >= 3
        if not on or r is None:
            return on
        since = paper_phases.since(self.phase_key)
        return since is None or r["opened_at"] >= since

    async def run(self) -> None:
        stops = asyncio.create_task(self._stop_loop())
        try:
            while True:
                try:
                    await self.step()
                except asyncio.CancelledError:
                    raise
                except Exception:
                    log.exception("copy paper tick failed")
                await asyncio.sleep(TICK_S)
        finally:
            stops.cancel()

    async def _stop_loop(self) -> None:
        while True:
            await asyncio.sleep(STOP_CHECK_S)
            try:
                await self._check_stops()
            except asyncio.CancelledError:
                raise
            except Exception as err:
                log.info(f"copy[{self.variant}] stop check failed: %s", err)

    async def _check_stops(self) -> None:
        """Re-mark open copies from the wallet's own position in that pool and cut those at or under STOP_PCT."""
        open_rows = [dict(r) for r in await self.db.fetch(f"select * from {self.t}_runs where status = 'open'")]
        for wallet, pool in {(r["wallet"], r["pool"]) for r in open_rows}:
            detail = await asyncio.to_thread(
                portfolio._get, f"/positions/{pool}/pnl", {"user": wallet, "status": "open", "page_size": 50})
            marks = {p.get("positionAddress"): portfolio._f(p.get("pnlPctChange")) for p in detail.get("positions") or []}
            now = datetime.now(timezone.utc)
            for r in open_rows:
                if r["wallet"] != wallet or r["pool"] != pool:
                    continue
                if r["position"] not in marks:
                    # Closed by the wallet. Copies of a wallet that has since left the followed list used to stay
                    # "open" forever (282 in phase 1); they close here at the wallet's final result like any other.
                    final = await asyncio.to_thread(_final_pnl_pct, wallet, pool, r["position"])
                    await self._close(r, now, r["last_pnl_pct"] if final is None else final, "follow")
                    continue
                mark = marks[r["position"]]
                if self._stops(r) and copy_return_pct(r["entry_pnl_pct"], mark) <= STOP_PCT:
                    await self._close(r, now, mark, "stop")
                else:
                    await self.db.execute(
                        f"update {self.t}_runs set last_pnl_pct = $2, checked_at = $3 where id = $1", r["id"], mark, now)

    async def step(self) -> None:
        now = datetime.now(timezone.utc)
        wallets = [l["wallet"] for l in await followed(self.db, self.variant)]
        for w in wallets:
            try:
                live = await asyncio.to_thread(_open_positions, w)
            except Exception as err:
                log.info(f"copy[{self.variant}] %s read failed: %s", w[:4], err)
                continue
            first_look = not await self.db.fetchval(f"select 1 from {self.t}_seen where wallet = $1 limit 1", w)
            copy_ok, _why = await eligible(self.db, w, self.variant)
            live_ids = {q["address"] for q in live}
            for q in live:
                if await self.db.fetchval(f"select 1 from {self.t}_seen where position = $1", q["address"]):
                    await self.db.execute(
                        f"update {self.t}_runs set last_pnl_pct = $2, checked_at = $3 where position = $1 and status = 'open'",
                        q["address"], q["pnl_pct"], now)
                    if self._stops():
                        r = await self.db.fetchrow(
                            f"select * from {self.t}_runs where position = $1 and status = 'open'", q["address"])
                        if r and self._stops(dict(r)) and copy_return_pct(r["entry_pnl_pct"], q["pnl_pct"]) <= STOP_PCT:
                            await self._close(dict(r), now, q["pnl_pct"], "stop")
                    continue
                await self.db.execute(
                    f"insert into {self.t}_seen (position, wallet, first_seen) values ($1, $2, $3) on conflict do nothing",
                    q["address"], w, now)
                created = (q.get("created_at") or 0) / 1000
                shadow = False
                if self.variant == "top" and not TOP_ACCEPTING:
                    continue
                if not copy_ok:
                    if self.variant != "small" or paper_phases.current("copy_small") < 3:
                        continue
                    shadow = True  # not proven yet: copied to build its record, not counted
                if first_look or time.time() - created > FRESH_MIN * 60:
                    continue
                if (q["pnl_pct"] or 0) <= -50:
                    continue  # already down half on arrival: a broken or emptied position, not one to copy
                if (self.variant == "small" and paper_phases.current("copy_small") >= 2
                        and (q["pnl_pct"] or 0) < SMALL_MAX_ENTRY_PCT):
                    continue
                await self.db.execute(
                    f"""insert into {self.t}_runs (wallet, position, pool, pair, their_created_at, opened_at, status,
                         size_usd, entry_pnl_pct, last_pnl_pct, their_deposit_usd, min_price, max_price, checked_at, shadow)
                       values ($1,$2,$3,$4,to_timestamp($5),$6,'open',$7,$8,$8,$9,$10,$11,$6,$12)""",
                    w, q["address"], q["pool"], q["pair"], created, now, SIZE_USD, q["pnl_pct"] or 0.0,
                    q.get("deposit_usd"), q.get("min_price"), q.get("max_price"), shadow)
                log.info(f"copy[{self.variant}] %s: %s %s (seen %.0fs after they opened)", w[:4], q["pair"], q["address"][:6], time.time() - created)
            # Copies whose position left the wallet's open list: close at the wallet's final result.
            for r in await self.db.fetch(f"select * from {self.t}_runs where wallet = $1 and status = 'open'", w):
                if r["position"] in live_ids:
                    continue
                final = await asyncio.to_thread(_final_pnl_pct, w, r["pool"], r["position"])
                if final is None:
                    final = r["last_pnl_pct"]  # not listed as closed yet: the last mark we saw
                await self._close(dict(r), now, final, "follow")

    async def _close(self, r: dict[str, Any], now: datetime, final: float | None, reason: str) -> None:
        """Close a copy at the wallet's PnL % `final`: when they closed ("follow"), or our own stop ("stop")."""
        result_pct = copy_return_pct(r["entry_pnl_pct"], final)
        costs = TX_FEE_SOL * self.sol_usd() + r["size_usd"] * EXIT_SWAP_PCT / 100
        pnl = r["size_usd"] * result_pct / 100 - costs
        await self.db.execute(
            f"""update {self.t}_runs set status = 'closed', closed_at = $2, exit_pnl_pct = $3, result_pct = $4,
                 costs_usd = $5, pnl_usd = $6, exit_reason = $7 where id = $1 and status = 'open'""",
            r["id"], now, final, result_pct, costs, pnl, reason)
        log.info(f"copy[{self.variant}] %s closed %s (%s): %+.2f USD", r["wallet"][:4], r["pair"], reason, pnl)


async def report(db, rows: dict[str, dict[str, Any]] | None = None, variant: str = "top") -> dict[str, Any]:
    t, phase_key = VARIANTS[variant]
    since = paper_phases.since(phase_key) or datetime.min.replace(tzinfo=timezone.utc)
    runs = [dict(r) for r in await db.fetch(
        f"select * from {t}_runs where opened_at >= $1 and not shadow order by opened_at desc limit 300", since)]
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
            "exit_reason": r.get("exit_reason"),
        })
    # Totals over the whole phase, not only the 300 rows listed.
    agg = await db.fetchrow(
        f"""select count(*) filter (where status = 'open') as open, count(*) filter (where status = 'closed') as closed,
                  coalesce(sum(pnl_usd) filter (where status = 'closed'), 0) as pnl,
                  count(*) filter (where status = 'closed' and pnl_usd > 0) as wins
           from {t}_runs where opened_at >= $1 and not shadow""", since)
    wallets = []
    for w in await followed(db, variant):
        ok, why = await eligible(db, w["wallet"], variant)
        wallets.append({**w, "copied": ok, "copy_note": why})
    return {
        "variant": variant,
        "params": {"follow": SMALL_FOLLOW if variant == "small" else FOLLOW, "size_usd": SIZE_USD, "tick_s": TICK_S, "fresh_min": FRESH_MIN,
                   "exit_swap_pct": EXIT_SWAP_PCT, "min_median_hold_h": MIN_MEDIAN_HOLD_H, "track_n": TRACK_N},
        "wallets": wallets,
        "phases": paper_phases.info(phase_key),
        "criteria": {"max_deposit_usd": SMALL_MAX_DEPOSIT, "min_median_pct": SMALL_MIN_MEDIAN_PCT,
                     "min_hold_h": SMALL_MIN_HOLD_H, "stop_pct": STOP_PCT} if variant == "small" else None,
        "counts": {"open": agg["open"], "closed": agg["closed"]},
        "pnl_usd": float(agg["pnl"]),
        "win_rate": agg["wins"] / agg["closed"] if agg["closed"] else None,
        "runs": out,
    }
