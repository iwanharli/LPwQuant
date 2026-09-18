"""The user's own DLMM LP portfolio, read-only, from Meteora's portfolio API.

Only a public wallet address is involved: positions on Solana are public, so no key, signature or approval is
ever needed, and this module has no way to move funds. The dashboard's Connect wallet button only reads the
address from the wallet extension.

Meteora already computes PnL per position from deposits, withdrawals, claimed and unclaimed fees, so this module
does not recompute it. What Meteora does not keep is a history of that PnL, which is what "profit per day" needs:
a snapshot per wallet every SNAPSHOT_EVERY_MS goes into portfolio_snapshots, and the day's profit is the change of
open-position PnL plus closed-position PnL between the last snapshot of one WIB day and the last of the next.
"""

import asyncio
import json
import logging
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from . import config

log = logging.getLogger("portfolio")

SNAPSHOT_EVERY_MS = 15 * 60_000
CACHE_MS = 15_000  # the page polls every 20s; the cache only absorbs several open tabs
MAX_POOLS = 60
_WALLET = re.compile(r"^[1-9A-HJ-NP-Za-km-z]{32,44}$")  # base58 public key
_cache: dict[str, tuple[int, dict[str, Any]]] = {}


def valid_wallet(address: str) -> bool:
    return bool(_WALLET.match(address or ""))


def _f(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _get(path: str, params: dict[str, Any]) -> Any:
    url = f"{config.METEORA_API_URL}{path}?{urllib.parse.urlencode(params)}"
    request = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "quant-engine"})
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.load(response)


async def _record_usage(db, calls: int, errors: int) -> None:
    """Counted with the ingestor's calls, so the API usage page shows these too."""
    if db is None:
        return
    rows = [(k, n) for k, n in (("http", calls), ("http_error", errors)) if n]
    for kind, count in rows:
        await db.execute(
            """insert into rpc_usage (hour, provider, kind, method, count, first_at)
               values (date_trunc('hour', now()), 'meteora', $1, 'portfolio', $2, now())
               on conflict (hour, provider, kind, method) do update set count = rpc_usage.count + excluded.count""",
            kind,
            count,
        )


def _position(p: dict[str, Any]) -> dict[str, Any]:
    unreal = p.get("unrealizedPnl") or {}
    deposits = (p.get("allTimeDeposits") or {}).get("total") or {}
    withdrawals = (p.get("allTimeWithdrawals") or {}).get("total") or {}
    fees = (p.get("allTimeFees") or {}).get("total") or {}
    fee_x = unreal.get("unclaimedFeeTokenX") or {}
    fee_y = unreal.get("unclaimedFeeTokenY") or {}
    bal_x = unreal.get("balanceTokenX") or {}
    bal_y = unreal.get("balanceTokenY") or {}
    return {
        "address": p.get("positionAddress"),
        "lower_bin": p.get("lowerBinId"),
        "upper_bin": p.get("upperBinId"),
        "active_bin": p.get("poolActiveBinId"),
        "min_price": _f(p.get("minPrice")),
        "max_price": _f(p.get("maxPrice")),
        "active_price": _f(p.get("poolActivePrice")) or None,
        "out_of_range": p.get("isOutOfRange"),
        "created_at": (p.get("createdAt") or 0) * 1000 or None,
        "value_usd": _f(unreal.get("balances")),
        "value_sol": _f(unreal.get("balancesSol")),
        "amount_x": _f(bal_x.get("amount")),
        "amount_y": _f(bal_y.get("amount")),
        "unclaimed_fee_x": _f(fee_x.get("amount")),
        "unclaimed_fee_y": _f(fee_y.get("amount")),
        "unclaimed_fees_usd": _f(fee_x.get("usd")) + _f(fee_y.get("usd")),
        "deposit_usd": _f(deposits.get("usd")),
        "withdrawn_usd": _f(withdrawals.get("usd")),
        "fees_usd": _f(fees.get("usd")),
        "pnl_usd": _f(p.get("pnlUsd")),
        "pnl_pct": _f(p.get("pnlPctChange")),
        "pnl_sol": _f(p.get("pnlSol")),
        "pnl_sol_pct": _f(p.get("pnlSolPctChange")),
        "fee_tvl_24h": _f(p.get("feePerTvl24h")),
    }


def _fetch(wallet: str) -> tuple[dict[str, Any], int, int]:
    """Blocking: every call Meteora needs for one wallet. Returns (portfolio, calls, errors)."""
    calls = errors = 0

    def get(path: str, params: dict[str, Any]) -> Any:
        nonlocal calls, errors
        calls += 1
        try:
            return _get(path, params)
        except (urllib.error.URLError, TimeoutError, ValueError):
            errors += 1
            raise

    open_ = get("/portfolio/open", {"user": wallet, "page_size": MAX_POOLS})
    total = get("/portfolio/total", {"user": wallet})
    pools = []
    for item in open_.get("pools") or []:
        address = item.get("poolAddress")
        try:
            detail = get(f"/positions/{address}/pnl", {"user": wallet, "status": "open", "page_size": 50})
            positions = [_position(p) for p in detail.get("positions") or [] if not p.get("isClosed")]
        except (urllib.error.URLError, TimeoutError, ValueError):
            positions = []  # the pool row still shows; only the per-position detail is missing
        pools.append(
            {
                "address": address,
                "name": f"{item.get('tokenX') or '?'}-{item.get('tokenY') or '?'}",
                "token_x": item.get("tokenX"),
                "token_y": item.get("tokenY"),
                "token_x_icon": item.get("tokenXIcon"),
                "token_y_icon": item.get("tokenYIcon"),
                "bin_step": item.get("binStep"),
                "base_fee": _f(item.get("baseFee")),
                "value_usd": _f(item.get("balances")),
                "value_sol": _f(item.get("balancesSol")),
                "deposit_usd": _f(item.get("totalDeposit")),
                "unclaimed_fees_usd": _f(item.get("unclaimedFees")),
                "pnl_usd": _f(item.get("pnl")),
                "pnl_pct": _f(item.get("pnlPctChange")),
                "pnl_sol": _f(item.get("pnlSol")),
                "pnl_sol_pct": _f(item.get("pnlSolPctChange")),
                "out_of_range": bool(item.get("outOfRange")),
                "open_positions": item.get("openPositionCount") or len(positions),
                "fee_tvl_24h": _f(item.get("feePerTvl24h")),
                "positions": positions,
            }
        )
    pools.sort(key=lambda p: p["value_usd"], reverse=True)
    summary = {
        "value_usd": sum(p["value_usd"] for p in pools),
        "value_sol": sum(p["value_sol"] for p in pools),
        "deposit_usd": sum(p["deposit_usd"] for p in pools),
        "unclaimed_fees_usd": sum(p["unclaimed_fees_usd"] for p in pools),
        "open_pnl_usd": sum(p["pnl_usd"] for p in pools),
        "open_pnl_sol": sum(p["pnl_sol"] for p in pools),
        "positions": sum(p["open_positions"] for p in pools),
        "out_of_range": sum(1 for p in pools for q in p["positions"] if q["out_of_range"]),
        "closed_pnl_usd": _f(total.get("totalPnlUsd")),
        "closed_pnl_sol": _f(total.get("totalPnlSol")),
        "closed_positions": total.get("totalClosedPositions") or 0,
        "sol_price": _f(open_.get("solPrice")) or None,
    }
    return {"wallet": wallet, "summary": summary, "pools": pools}, calls, errors


async def fetch_portfolio(db, wallet: str, fresh: bool = False) -> dict[str, Any]:
    now = int(time.time() * 1000)
    cached = _cache.get(wallet)
    if cached and not fresh and now - cached[0] < CACHE_MS:
        return cached[1]
    calls = errors = 0
    try:
        data, calls, errors = await asyncio.to_thread(_fetch, wallet)
    finally:
        await _record_usage(db, calls or 1, errors if calls else 1)
    data["fetched_at"] = now
    _cache[wallet] = (now, data)
    return data


async def add_wallet(db, wallet: str) -> None:
    await db.execute("insert into portfolio_wallets (address) values ($1) on conflict do nothing", wallet)


async def snapshot(db, data: dict[str, Any]) -> None:
    s = data["summary"]
    await db.execute(
        """insert into portfolio_snapshots
             (wallet, ts, value_usd, value_sol, deposit_usd, unclaimed_fees_usd, open_pnl_usd, open_pnl_sol,
              closed_pnl_usd, closed_pnl_sol, positions)
           values ($1, now(), $2, $3, $4, $5, $6, $7, $8, $9, $10)""",
        data["wallet"], s["value_usd"], s["value_sol"], s["deposit_usd"], s["unclaimed_fees_usd"],
        s["open_pnl_usd"], s["open_pnl_sol"], s["closed_pnl_usd"], s["closed_pnl_sol"], s["positions"],
    )


async def snapshot_loop(db) -> None:
    """Every registered wallet, every SNAPSHOT_EVERY_MS. Failures are logged and retried on the next round."""
    while True:
        try:
            wallets = [r["address"] for r in await db.fetch("select address from portfolio_wallets")]
            for wallet in wallets:
                try:
                    await snapshot(db, await fetch_portfolio(db, wallet, fresh=True))
                except Exception as err:
                    log.warning("portfolio snapshot failed for %s…: %s", wallet[:4], err)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("portfolio snapshot round failed")
        await asyncio.sleep(SNAPSHOT_EVERY_MS / 1000)


def daily_pnl(rows: list[dict[str, Any]], tz: str = config.TIMEZONE) -> list[dict[str, Any]]:
    """Profit per local day from snapshots (oldest first): the change of lifetime PnL (open + closed) from the last
    snapshot of the previous day to the last of this one. Deposits and withdrawals do not show up as profit because
    Meteora's PnL already nets them out. The first day has no previous close, so it starts from its first snapshot."""
    zone = ZoneInfo(tz)
    last_by_day: dict[str, dict[str, Any]] = {}
    first_by_day: dict[str, dict[str, Any]] = {}
    for r in rows:
        day = r["ts"].astimezone(zone).date().isoformat()
        first_by_day.setdefault(day, r)
        last_by_day[day] = r
    out = []
    previous: dict[str, Any] | None = None
    for day in sorted(last_by_day):
        close = last_by_day[day]
        start = previous or first_by_day[day]
        lifetime = lambda r: r["open_pnl_usd"] + r["closed_pnl_usd"]  # noqa: E731
        lifetime_sol = lambda r: r["open_pnl_sol"] + r["closed_pnl_sol"]  # noqa: E731
        out.append(
            {
                "day": day,
                "pnl_usd": lifetime(close) - lifetime(start),
                "pnl_sol": lifetime_sol(close) - lifetime_sol(start),
                "value_usd": close["value_usd"],
                "partial": previous is None,
            }
        )
        previous = close
    return out


async def history(db, wallet: str, days: int = 30) -> dict[str, Any]:
    since = datetime.now(ZoneInfo(config.TIMEZONE)) - timedelta(days=days + 1)
    rows = [
        dict(r)
        for r in await db.fetch(
            """select ts, value_usd, value_sol, open_pnl_usd, open_pnl_sol, closed_pnl_usd, closed_pnl_sol,
                      unclaimed_fees_usd
               from portfolio_snapshots where wallet = $1 and ts >= $2 order by ts""",
            wallet,
            since,
        )
    ]
    daily = daily_pnl(rows)[-days:]
    series = [
        {"ts": int(r["ts"].timestamp() * 1000), "value_usd": r["value_usd"],
         "pnl_usd": r["open_pnl_usd"] + r["closed_pnl_usd"]}
        for r in rows
    ]
    return {"daily": daily, "series": series, "tracking_since": series[0]["ts"] if series else None}
