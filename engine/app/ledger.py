"""The wallet's money in one place: capital put in, what it is worth now, and where the difference came from.

Meteora's LP PnL only covers what happens inside positions. Most of what a wallet gains or loses happens around
them -- memecoin trades, tokens that die after leaving a position, gacha packs -- so the ledger splits the total:

    total P/L = net worth now - capital
    LP        = Meteora's PnL of closed + open positions
    gacha     = USDC/SOL paid for packs minus what came back when cards were sold back (exact, from the chain)
    trading   = the rest: swaps, memecoins bought and sold, tokens that lost value in the wallet, fees

"Trading" is a remainder, not a sum of trades, because a trade's cost needs the market price at that second,
which is not recorded; the remainder is exact as long as capital and net worth are.

The guard runs with every portfolio snapshot and tells Telegram when a day turns red outside LP.
"""

import asyncio
import json
import logging
import time
import urllib.error
import urllib.request
from datetime import date, datetime
from typing import Any
from zoneinfo import ZoneInfo

from . import config, portfolio

log = logging.getLogger("ledger")

USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
SOL = "So11111111111111111111111111111111111111112"
GACHA_REFUND_WINDOW_S = 30 * 60  # a card sold back arrives minutes after the pack was paid for
GACHA_REFUND_MAX_USD = 200.0
FX_CACHE_S = 6 * 3600
TRADING_ALERT_USD = (-20.0, -50.0, -100.0)
GACHA_ALERT_USD = (-10.0, -30.0)
RECAP_HOUR_WIB = 23  # daily recap goes out in the last hour of the day

_fx: tuple[float, float] | None = None
_zone = ZoneInfo(config.TIMEZONE)


def usd_idr() -> float:
    """Rupiah per dollar, from a free FX feed, cached; USD_IDR in .env when the feed is unreachable."""
    global _fx
    if _fx and time.time() - _fx[0] < FX_CACHE_S:
        return _fx[1]
    try:
        with urllib.request.urlopen("https://open.er-api.com/v6/latest/USD", timeout=15) as r:
            rate = float(json.load(r)["rates"]["IDR"])
        _fx = (time.time(), rate)
        return rate
    except (urllib.error.URLError, TimeoutError, ValueError, KeyError):
        return _fx[1] if _fx else config.USD_IDR_FALLBACK


def _money(row: dict[str, Any], sol_usd: float) -> float:
    """USD value of the SOL and USDC that moved in one transaction (the rest is memecoins, left to 'trading')."""
    deltas = row["deltas"] if isinstance(row["deltas"], list) else json.loads(row["deltas"] or "[]")
    usdc = sum(d["amount"] for d in deltas if d["mint"] == USDC)
    sol = (row["sol_delta"] or 0) + sum(d["amount"] for d in deltas if d["mint"] == SOL)
    return usdc + sol * sol_usd


def gacha_related(ts: datetime, usd: float, gacha_times: list[datetime]) -> bool:
    """A plain USDC transfer next to a gacha transaction is part of it: the pack is paid for (a transfer with a memo)
    minutes before the card is minted, and a card sold back pays out minutes after. Anything larger is real money."""
    if not 0 < abs(usd) <= GACHA_REFUND_MAX_USD:
        return False
    return any(abs((ts - g).total_seconds()) <= GACHA_REFUND_WINDOW_S for g in gacha_times)


async def _flows(db, wallet: str, sol_usd: float) -> dict[str, list[tuple[datetime, float]]]:
    """Deposits, withdrawals and gacha as (time, USD) lists. A deposit arriving within minutes of a gacha payment
    is the card being sold back, so it counts to gacha, not to capital."""
    rows = [
        dict(r)
        for r in await db.fetch(
            """select ts, kind, sol_delta, deltas, signature from portfolio_activity
               where wallet = $1 and ok and kind in ('deposit', 'withdraw', 'gacha') order by ts""",
            wallet,
        )
    ]
    gacha_times = [r["ts"] for r in rows if r["kind"] == "gacha"]
    out: dict[str, list[tuple[datetime, float]]] = {"deposit": [], "withdraw": [], "gacha": []}
    events: list[dict[str, Any]] = []
    for r in rows:
        usd = _money(r, sol_usd)
        if r["kind"] in ("deposit", "withdraw") and gacha_related(r["ts"], usd, gacha_times):
            out["gacha"].append((r["ts"], usd))
        else:
            out[r["kind"]].append((r["ts"], usd))
            if r["kind"] != "gacha":
                events.append({"ts": int(r["ts"].timestamp() * 1000), "usd": usd, "kind": r["kind"], "signature": r["signature"]})
    out["events"] = events  # type: ignore[assignment]  # capital moves on chain, for the page's timeline
    return out


async def capital_entries(db, wallet: str) -> list[dict[str, Any]]:
    rows = await db.fetch(
        "select id, ts, amount_idr, amount_usd, source, note from portfolio_capital where wallet = $1 order by ts",
        wallet,
    )
    return [{**dict(r), "ts": int(r["ts"].timestamp() * 1000)} for r in rows]


async def add_capital(db, wallet: str, amount_idr: float | None, amount_usd: float | None, note: str | None,
                      ts: datetime | None) -> None:
    rate = await asyncio.to_thread(usd_idr)
    usd = amount_usd if amount_usd is not None else (amount_idr or 0) / rate
    await db.execute(
        """insert into portfolio_capital (wallet, ts, amount_idr, amount_usd, source, note)
           values ($1, $2, $3, $4, 'manual', $5)""",
        wallet, ts or datetime.now(_zone), amount_idr, usd, note,
    )


async def delete_capital(db, wallet: str, entry_id: int) -> None:
    await db.execute("delete from portfolio_capital where wallet = $1 and id = $2 and source = 'manual'", wallet, entry_id)


async def _latest_networth(db, wallet: str) -> dict[str, Any] | None:
    r = await db.fetchrow(
        """select ts, wallet_usd, lp_usd, orders_usd, total_usd from portfolio_networth_snapshots
           where wallet = $1 order by ts desc limit 1""",
        wallet,
    )
    return dict(r) if r else None


async def days(db, wallet: str, sol_usd: float, n: int = 14) -> list[dict[str, Any]]:
    """Per WIB day since snapshots began: how net worth moved, and how much of it was new money, LP, gacha, and
    everything else (trading)."""
    snaps = await db.fetch(
        """select ts, total_usd from portfolio_networth_snapshots where wallet = $1 and ts >= now() - make_interval(days => $2)
           order by ts""",
        wallet, n + 1,
    )
    if not snaps:
        return []
    lp_rows = [
        dict(r)
        for r in await db.fetch(
            """select ts, value_usd, open_pnl_usd, open_pnl_sol, closed_pnl_usd, closed_pnl_sol from portfolio_snapshots
               where wallet = $1 and ts >= now() - make_interval(days => $2) order by ts""",
            wallet, n + 1,
        )
    ]
    lp_by_day = {d["day"]: d["pnl_usd"] for d in portfolio.daily_pnl(lp_rows)}
    flows = await _flows(db, wallet, sol_usd)

    tracked_from = snaps[0]["ts"]

    def by_day(items):
        out: dict[str, float] = {}
        for ts, usd in items:
            if ts < tracked_from:
                continue  # before the first snapshot: already inside the net worth the first day starts from
            k = ts.astimezone(_zone).date().isoformat()
            out[k] = out.get(k, 0.0) + usd
        return out

    dep, wd, gacha = by_day(flows["deposit"]), by_day(flows["withdraw"]), by_day(flows["gacha"])
    first: dict[str, float] = {}
    last: dict[str, float] = {}
    for s in snaps:
        k = s["ts"].astimezone(_zone).date().isoformat()
        first.setdefault(k, s["total_usd"])
        last[k] = s["total_usd"]
    out = []
    prev_close = None
    for k in sorted(last):
        start = prev_close if prev_close is not None else first[k]
        change = last[k] - start
        new_money = dep.get(k, 0.0) + wd.get(k, 0.0)
        lp = lp_by_day.get(k, 0.0)
        g = gacha.get(k, 0.0)
        out.append({
            "day": k,
            "networth": last[k],
            "change": change,
            "new_money": new_money,
            "lp": lp,
            "gacha": g,
            "trading": change - new_money - lp - g,
            "partial": prev_close is None,
        })
        prev_close = last[k]
    return out[-n:]


async def summary(db, wallet: str) -> dict[str, Any]:
    rate = await asyncio.to_thread(usd_idr)
    pf = await portfolio.fetch_portfolio(db, wallet)
    sol_usd = pf["summary"].get("sol_price") or config.SOL_USD_FALLBACK
    entries = await capital_entries(db, wallet)
    flows = await _flows(db, wallet, sol_usd)
    manual = [e for e in entries if e["source"] == "manual"]
    chain_deposits = sum(usd for _, usd in flows["deposit"])
    chain_withdrawals = sum(usd for _, usd in flows["withdraw"])
    chain_net = chain_deposits + chain_withdrawals
    # Dollars: what actually arrived on chain (plus dollar entries typed by hand). Rupiah: what the user paid, when
    # written down, since a QRIS top-up converts at its own rate; money moving on chain after the last note is added
    # at today's rate. Each currency's P/L is then honest in its own terms (the rupiah one includes the FX move).
    manual_idr = [e for e in manual if e["amount_idr"] is not None]
    manual_usd_only = sum(e["amount_usd"] for e in manual if e["amount_idr"] is None)
    capital_usd = (chain_net or sum(e["amount_usd"] for e in manual_idr)) + manual_usd_only
    if manual_idr:
        since = max(e["ts"] for e in manual_idr)
        after = sum(usd for ts, usd in flows["deposit"] + flows["withdraw"] if ts.timestamp() * 1000 > since)
        capital_idr = sum(e["amount_idr"] for e in manual_idr) + (after + manual_usd_only) * rate
    else:
        capital_idr = capital_usd * rate
    nw = await _latest_networth(db, wallet)
    networth = nw["total_usd"] if nw else pf["summary"]["value_usd"]
    total = networth - capital_usd
    lp = pf["summary"]["open_pnl_usd"] + pf["summary"]["closed_pnl_usd"]
    gacha = sum(usd for _, usd in flows["gacha"])
    return {
        "fx": {"usd_idr": rate},
        "capital": {"usd": capital_usd, "idr": capital_idr, "entries": entries, "chain_events": flows["events"],
                    "basis": "manual" if manual_idr else "chain",
                    "chain_deposits_usd": chain_deposits, "chain_withdrawals_usd": chain_withdrawals},
        "networth": {"usd": networth, "idr": networth * rate, "at": int(nw["ts"].timestamp() * 1000) if nw else None,
                     "wallet_usd": nw["wallet_usd"] if nw else None, "lp_usd": nw["lp_usd"] if nw else None,
                     "orders_usd": nw["orders_usd"] if nw else None},
        "pl": {"usd": total, "idr": networth * rate - capital_idr, "pct": (total / capital_usd * 100) if capital_usd else None},
        "breakdown": {"lp": lp, "gacha": gacha, "trading": total - lp - gacha},
        # Rupiah P/L minus the dollar P/L at today's rate: what the exchange rate alone did since the top-ups.
        "fx_idr": (networth * rate - capital_idr) - total * rate,
        "days": await days(db, wallet, sol_usd),
    }


# ---- Guard: Telegram when a day turns red outside LP ------------------------------------------------------------

def _fmt(v: float) -> str:
    return f"{'+' if v >= 0 else '−'}${abs(v):,.2f}"


async def _once(db, wallet: str, day: date, key: str) -> bool:
    """True the first time (wallet, day, key) is seen: each warning goes out once a day."""
    r = await db.fetchval(
        "insert into portfolio_guard_sent (wallet, day, key) values ($1, $2, $3) on conflict do nothing returning 1",
        wallet, day, key,
    )
    return bool(r)


async def guard(db, wallet: str) -> None:
    from .alerts import _post  # the alerter's sender; it is inert without a token

    token, chat = config.TELEGRAM_BOT_TOKEN, config.TELEGRAM_CHAT_ID
    if not (config.ALERTS_ENABLED and token and chat):
        return
    s = await summary(db, wallet)
    if not s["days"]:
        return
    today = s["days"][-1]
    day = date.fromisoformat(today["day"])
    rate = s["fx"]["usd_idr"]
    rp = lambda v: f"Rp{abs(v) * rate / 1e6:,.1f} jt"  # noqa: E731
    messages = []
    # One message per crossing: when a day is already past several thresholds, only the deepest is announced and
    # the shallower ones are marked as sent, so the chat does not get a warning every 15 minutes.
    async def deepest(value: float, limits: tuple[float, ...], prefix: str) -> float | None:
        crossed = [lim for lim in limits if value <= lim]
        if not crossed:
            return None
        lim = min(crossed)
        fresh = await _once(db, wallet, day, f"{prefix}{lim}")
        for other in crossed:
            await _once(db, wallet, day, f"{prefix}{other}")
        return lim if fresh else None

    if await deepest(today["trading"], TRADING_ALERT_USD, "trading") is not None:
        messages.append(
            f"🛑 <b>Trading hari ini sudah {_fmt(today['trading'])}</b> (−{rp(today['trading'])})\n"
            f"Di luar LP: swap memecoin, beli-jual cepat, token yang jatuh. Dari data kamu sendiri, bagian ini yang "
            f"menghabiskan modal. Berhenti dulu untuk hari ini."
        )
    if await deepest(today["gacha"], GACHA_ALERT_USD, "gacha") is not None:
        messages.append(f"🎰 <b>Gacha hari ini {_fmt(today['gacha'])}</b>. Pack yang dijual kembali rata-rata rugi ±18%.")
    now = datetime.now(_zone)
    if now.hour >= RECAP_HOUR_WIB and now.date() == day and await _once(db, wallet, day, "recap"):
        verdict = "✅ Hari hijau" if today["change"] - today["new_money"] >= 0 else "🔻 Hari merah"
        messages.append(
            f"📒 <b>Rekap {now.strftime('%d %b')}</b> · {verdict}\n\n"
            f"Kekayaan: ${today['networth']:,.2f} ({_fmt(today['change'] - today['new_money'])} di luar setoran)\n"
            f"• LP: {_fmt(today['lp'])}\n"
            f"• Trading & token: {_fmt(today['trading'])}\n"
            f"• Gacha: {_fmt(today['gacha'])}\n"
            + (f"• Setoran/penarikan: {_fmt(today['new_money'])}\n" if abs(today["new_money"]) >= 1 else "")
            + f"\nSejak awal: {_fmt(s['pl']['usd'])} ({'+' if s['pl']['usd'] >= 0 else '−'}{rp(s['pl']['usd'])}) dari modal "
            f"{rp(s['capital']['usd'])}"
        )
    for m in messages:
        await asyncio.to_thread(_post, token, chat, m)
