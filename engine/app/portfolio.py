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
                "mint_x": item.get("tokenXMint"),
                "mint_y": item.get("tokenYMint"),
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
                    data = await fetch_portfolio(db, wallet, fresh=True)
                    await snapshot(db, data)
                    await snapshot_positions(db, data)
                    await snapshot_networth(db, wallet, data)
                    from . import ledger  # local: ledger imports this module

                    await ledger.guard(db, wallet)
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


ORDERS_CACHE_MS = 15_000
_orders_cache: dict[str, tuple[int, dict[str, Any]]] = {}


def _order(o: dict[str, Any]) -> dict[str, Any]:
    return {
        "address": o.get("limit_order_address"),
        "is_ask": bool(o.get("is_ask_side")),
        "input_token": o.get("input_token"),
        "output_token": o.get("output_token"),
        "lower_price": _f(o.get("lower_pool_price")),
        "upper_price": _f(o.get("upper_pool_price")),
        "input_amount": _f(o.get("input_amount")),
        "input_usd": _f(o.get("input_amount_usd")),
        "output_expected": _f(o.get("output_amount_expected")),
        "filled_pct": _f(o.get("filled_pct")),
        "filled_output": _f(o.get("total_filled_amount")),
        "filled_output_usd": _f(o.get("total_filled_amount_usd")),
        "unfilled_input": _f(o.get("total_unfilled_amount")),
        "unfilled_usd": _f(o.get("total_unfilled_amount_usd")),
        "bonus_usd": _f(o.get("total_bonus_usd")),
        "pnl_usd": _f(o.get("unrealized_pnl_usd")),
        "pnl_pct": _f(o.get("unrealized_pnl_pct_usd")),
        "opened_at": (o.get("opened_at") or 0) * 1000 or None,
        "bins": [
            {
                "bin": b.get("bin_id"),
                "price": _f(b.get("price")),
                "deposit": _f(b.get("deposit_amount")),
                "filled": _f(b.get("fulfilled_amount")),
                "status": b.get("fill_status"),
            }
            for b in o.get("bin_distribution") or []
        ],
    }


def _fetch_orders(wallet: str) -> tuple[dict[str, Any], int, int]:
    calls = errors = 0

    def get(path: str, params: dict[str, Any]) -> Any:
        nonlocal calls, errors
        calls += 1
        try:
            return _get(path, params)
        except (urllib.error.URLError, TimeoutError, ValueError):
            errors += 1
            raise

    pools_out = []
    listing = get(f"/wallets/{wallet}/limit_orders/open/pools", {"page_size": 50})
    for item in listing.get("data") or []:
        pool = item.get("pool") or {}
        address = pool.get("pool_address")
        detail = get(f"/wallets/{wallet}/limit_orders/open/pools/{address}", {"page_size": 50})
        pools_out.append(
            {
                "address": address,
                "name": pool.get("pair_name"),
                "token_x": pool.get("token_x"),
                "token_y": pool.get("token_y"),
                "token_x_icon": pool.get("token_x_icon"),
                "token_y_icon": pool.get("token_y_icon"),
                "bin_step": pool.get("bin_step"),
                "active_bin": detail.get("current_active_bin_id"),
                "price": _f(detail.get("current_pool_price")),
                "orders": [_order(o) for o in detail.get("data") or []],
            }
        )
    return {"wallet": wallet, "pools": pools_out}, calls, errors


async def fetch_orders(db, wallet: str, fresh: bool = False) -> dict[str, Any]:
    """Open limit orders of a wallet, from Meteora's limit-order API. Read-only."""
    now = int(time.time() * 1000)
    cached = _orders_cache.get(wallet)
    if cached and not fresh and now - cached[0] < ORDERS_CACHE_MS:
        return cached[1]
    calls = errors = 0
    try:
        data, calls, errors = await asyncio.to_thread(_fetch_orders, wallet)
    finally:
        await _record_usage(db, calls or 1, errors if calls else 1)
    data["fetched_at"] = now
    _orders_cache[wallet] = (now, data)
    return data


# ---- History ---------------------------------------------------------------------------------------------------

ACTIVITY_KINDS = {
    "claim", "add_liquidity", "remove_liquidity", "rebalance", "limit_order_place", "limit_order_cancel", "swap",
    "deposit", "withdraw", "gacha", "transfer", "other",
}
_SIGNATURE = re.compile(r"^[1-9A-HJ-NP-Za-km-z]{64,90}$")


def valid_signature(sig: str) -> bool:
    return bool(_SIGNATURE.match(sig or ""))


async def snapshot_positions(db, data: dict[str, Any]) -> None:
    rows = [
        (data["wallet"], p["address"], pool["address"], pool["name"], p["value_usd"], p["pnl_usd"],
         p["unclaimed_fees_usd"], None if p["out_of_range"] is None else not p["out_of_range"])
        for pool in data["pools"]
        for p in pool["positions"]
    ]
    if rows:
        await db.executemany(
            """insert into portfolio_position_snapshots
                 (wallet, ts, position, pool, name, value_usd, pnl_usd, unclaimed_fees_usd, in_range)
               values ($1, date_trunc('minute', now()), $2, $3, $4, $5, $6, $7, $8) on conflict do nothing""",
            rows,
        )


def _wallet_usd(wallet: str) -> float | None:
    """Coins in the wallet, from the ingestor's /wallet (it holds the RPC key). None when the ingestor is down, so a
    missing reading is not stored as a wallet worth $0."""
    url = f"{config.CLAIM_SERVER_URL}/wallet?{urllib.parse.urlencode({'owner': wallet})}"
    try:
        with urllib.request.urlopen(url, timeout=60) as response:
            return float(json.load(response).get("total_usd") or 0)
    except (urllib.error.URLError, TimeoutError, ValueError):
        return None


async def snapshot_networth(db, wallet: str, data: dict[str, Any]) -> None:
    wallet_usd = await asyncio.to_thread(_wallet_usd, wallet)
    if wallet_usd is None:
        return
    s = data["summary"]
    lp = s["value_usd"] + s["unclaimed_fees_usd"]
    try:
        orders = await fetch_orders(db, wallet)
        orders_usd = sum(
            o["unfilled_usd"] + o["filled_output_usd"] + o["bonus_usd"] for pool in orders["pools"] for o in pool["orders"]
        )
    except Exception:
        orders_usd = 0.0  # no limit orders is the common case; a failed read only understates this one snapshot
    await db.execute(
        """insert into portfolio_networth_snapshots (wallet, ts, wallet_usd, lp_usd, orders_usd, total_usd)
           values ($1, date_trunc('minute', now()), $2, $3, $4, $5) on conflict do nothing""",
        wallet, wallet_usd, lp, orders_usd, wallet_usd + lp + orders_usd,
    )


async def record_activity(db, entry: dict[str, Any]) -> None:
    """An action sent from the app. The chain sync later fills in the exact token changes for the same signature;
    what the app knows (the kind, the pool, a note) is kept."""
    await db.execute(
        """insert into portfolio_activity (signature, wallet, ts, kind, source, ok, pool, deltas, note)
           values ($1, $2, now(), $3, 'app', true, $4, $5::jsonb, $6)
           on conflict (signature) do update set kind = excluded.kind, source = 'app',
             pool = coalesce(excluded.pool, portfolio_activity.pool),
             note = coalesce(excluded.note, portfolio_activity.note)""",
        entry["signature"], entry["wallet"], entry["kind"], entry.get("pool"),
        json.dumps(entry.get("deltas") or []), entry.get("note"),
    )


async def list_activity(
    db, wallet: str, limit: int = 50, kind: str | None = None, before: tuple[int, str] | None = None
) -> list[dict[str, Any]]:
    """Newest first, `limit` at a time. `before` is the (ts ms, signature) of the last row already shown: a keyset
    cursor, so paging stays fast however deep the history goes and rows arriving meanwhile do not shift pages."""
    before_ts = before_sig = None
    if before:
        before_ts, before_sig = before
    # Gacha refunds are stored as deposits and relabelled below, so a gacha filter has to fetch deposits too.
    kinds = ["gacha", "deposit", "withdraw"] if kind == "gacha" else ([kind] if kind else None)
    rows = await db.fetch(
        """select signature, ts, kind, source, ok, pool, sol_delta, deltas, note from portfolio_activity
           where wallet = $1 and ($2::text[] is null or kind = any($2))
             and ($4::bigint is null or (ts, signature) < (to_timestamp($4 / 1000.0), $5::text))
           order by ts desc, signature desc limit $3""",
        wallet, kinds, limit, before_ts, before_sig,
    )
    # A card sold back arrives as a plain USDC deposit minutes after the pack was paid for: show it as gacha, with
    # the same rule the ledger counts it by (engine/app/ledger.py).
    gacha_times = [
        r["ts"] for r in await db.fetch("select ts from portfolio_activity where wallet = $1 and kind = 'gacha'", wallet)
    ]
    out = []
    for r in rows:
        item = {**dict(r), "ts": int(r["ts"].timestamp() * 1000),
                "deltas": r["deltas"] if isinstance(r["deltas"], list) else json.loads(r["deltas"] or "[]")}
        if r["kind"] in ("deposit", "withdraw"):
            from .ledger import gacha_related  # local: ledger imports this module

            usdc = sum(d["amount"] for d in item["deltas"] if d.get("symbol") == "USDC")
            if gacha_related(r["ts"], usdc, gacha_times):
                item["kind"] = "gacha"
                item["note"] = item.get("note") or ("Bayar pack" if usdc < 0 else "Kartu dijual kembali")
        if kind == "gacha" and item["kind"] != "gacha":
            continue  # a real deposit fetched only because refunds share its kind
        out.append(item)
    return out


async def networth_history(db, wallet: str, days: int = 30) -> list[dict[str, Any]]:
    rows = await db.fetch(
        """select ts, wallet_usd, lp_usd, orders_usd, total_usd from portfolio_networth_snapshots
           where wallet = $1 and ts >= now() - make_interval(days => $2) order by ts""",
        wallet, days,
    )
    return [{**dict(r), "ts": int(r["ts"].timestamp() * 1000)} for r in rows]


async def position_history(db, wallet: str, position: str, days: int = 30) -> list[dict[str, Any]]:
    rows = await db.fetch(
        """select ts, value_usd, pnl_usd, unclaimed_fees_usd, in_range from portfolio_position_snapshots
           where wallet = $1 and position = $2 and ts >= now() - make_interval(days => $3) order by ts""",
        wallet, position, days,
    )
    return [{**dict(r), "ts": int(r["ts"].timestamp() * 1000)} for r in rows]


SOL_MINT = "So11111111111111111111111111111111111111112"


async def claims_daily(db, wallet: str) -> list[dict[str, Any]]:
    """Fees claimed per WIB day, per token, from the transaction history (so it reaches back as far as the backfill).
    Token amounts only: the dashboard prices them, since historical prices are not available for most memecoins.
    Fees paid out when a position is closed arrive mixed with the withdrawn liquidity and are not counted here."""
    rows = await db.fetch(
        """select (ts at time zone $2)::date as day, deltas, sol_delta from portfolio_activity
           where wallet = $1 and kind = 'claim' and ok order by 1""",
        wallet, config.TIMEZONE,
    )
    days: dict[str, dict[str, dict[str, Any]]] = {}
    counts: dict[str, int] = {}
    for r in rows:
        day = r["day"].isoformat()
        counts[day] = counts.get(day, 0) + 1
        tokens = days.setdefault(day, {})
        deltas = r["deltas"] if isinstance(r["deltas"], list) else json.loads(r["deltas"] or "[]")
        for d in deltas:
            if d["amount"] > 0:
                t = tokens.setdefault(d["mint"], {"symbol": d["symbol"], "amount": 0.0})
                t["amount"] += d["amount"]
        # Native SOL fees land in the wallet's own account, not a token account.
        if r["sol_delta"] and r["sol_delta"] > 0.0001:
            t = tokens.setdefault(SOL_MINT, {"symbol": "SOL", "amount": 0.0})
            t["amount"] += r["sol_delta"]
    return [{"day": day, "claims": counts[day], "tokens": [{"mint": m, **v} for m, v in tokens.items()]} for day, tokens in days.items()]


# ---- Closed positions and orders (Meteora keeps these; nothing of ours to snapshot) ----------------------------

HISTORY_CACHE_MS = 60_000
_closed_cache: dict[str, tuple[int, Any]] = {}


def _cached(key: str, fresh: bool, build) -> Any:
    now = int(time.time() * 1000)
    hit = _closed_cache.get(key)
    if hit and not fresh and now - hit[0] < HISTORY_CACHE_MS:
        return hit[1]
    value = build()
    _closed_cache[key] = (now, value)
    return value


def _closed_pools(wallet: str) -> list[dict[str, Any]]:
    out, page = [], 1
    while True:
        body = _get("/portfolio", {"user": wallet, "page": page, "page_size": 50})
        for p in body.get("pools") or []:
            out.append({
                "address": p.get("poolAddress"),
                "name": f"{p.get('tokenX') or '?'}/{p.get('tokenY') or '?'}",
                "token_x": p.get("tokenX"),
                "token_y": p.get("tokenY"),
                "mint_x": p.get("tokenXMint"),
                "mint_y": p.get("tokenYMint"),
                "token_x_icon": p.get("tokenXIcon"),
                "token_y_icon": p.get("tokenYIcon"),
                "bin_step": int(_f(p.get("binStep"))),
                "deposit_usd": _f(p.get("totalDeposit")),
                "withdrawn_usd": _f(p.get("totalWithdrawal")),
                "fees_usd": _f(p.get("totalFee")),
                "pnl_usd": _f(p.get("pnlUsd")),
                "pnl_pct": _f(p.get("pnlPctChange")),
                "pnl_sol": _f(p.get("pnlSol")),
                "closed_at": (p.get("lastClosedAt") or 0) * 1000 or None,
            })
        if not body.get("hasNext"):
            break
        page += 1
    out.sort(key=lambda p: p["closed_at"] or 0, reverse=True)
    return out


def _closed_positions(wallet: str, pool: str) -> list[dict[str, Any]]:
    body = _get(f"/positions/{pool}/pnl", {"user": wallet, "status": "closed", "page_size": 50})
    out = []
    for p in body.get("positions") or []:
        fees = (p.get("allTimeFees") or {}).get("total") or {}
        dep = (p.get("allTimeDeposits") or {}).get("total") or {}
        out.append({
            "address": p.get("positionAddress"),
            "opened_at": (p.get("createdAt") or 0) * 1000 or None,
            "closed_at": (p.get("closedAt") or 0) * 1000 or None,
            "lower_bin": p.get("lowerBinId"),
            "upper_bin": p.get("upperBinId"),
            "min_price": _f(p.get("minPrice")),
            "max_price": _f(p.get("maxPrice")),
            "deposit_usd": _f(dep.get("usd")),
            "fees_usd": _f(fees.get("usd")),
            "pnl_usd": _f(p.get("pnlUsd")),
            "pnl_pct": _f(p.get("pnlPctChange")),
            "pnl_sol": _f(p.get("pnlSol")),
        })
    out.sort(key=lambda p: p["closed_at"] or 0, reverse=True)
    return out


def _closed_orders(wallet: str) -> list[dict[str, Any]]:
    out, page = [], 1
    pools = []
    while True:
        body = _get(f"/wallets/{wallet}/limit_orders/closed/pools", {"page": page, "page_size": 50})
        pools += body.get("data") or []
        if page >= (body.get("pages") or 1):
            break
        page += 1
    for item in pools:
        pool = item.get("pool") or {}
        detail = _get(f"/wallets/{wallet}/limit_orders/closed/pools/{pool.get('pool_address')}", {"page_size": 100})
        for o in detail.get("data") or []:
            out.append({
                "address": o.get("limit_order_address"),
                "pool": pool.get("pool_address"),
                "pair": (pool.get("pair_name") or "").replace("-", "/"),
                "is_ask": bool(o.get("is_ask_side")),
                "input_token": o.get("input_token"),
                "output_token": o.get("output_token"),
                "lower_price": _f(o.get("lower_pool_price")),
                "upper_price": _f(o.get("upper_pool_price")),
                "deposit_usd": _f(o.get("total_deposit_usd")),
                "withdrawn_usd": _f(o.get("total_withdrawal_usd")),
                "filled_pct": _f(o.get("filled_pct")),
                "filled_input": _f(o.get("filled_input_amount")),
                "received_output": _f(o.get("received_output_amount")),
                "bonus_usd": _f(o.get("total_bonus_usd")),
                "pnl_usd": _f(o.get("realized_pnl_usd")),
                "pnl_pct": _f(o.get("realized_pnl_pct_usd")),
                "opened_at": (o.get("opened_at") or 0) * 1000 or None,
                "closed_at": (o.get("last_closed_at") or 0) * 1000 or None,
                "signature": o.get("terminal_signature"),
            })
    out.sort(key=lambda o: o["closed_at"] or 0, reverse=True)
    return out


async def closed_pools(db, wallet: str, fresh: bool = False) -> list[dict[str, Any]]:
    try:
        return await asyncio.to_thread(_cached, f"cp:{wallet}", fresh, lambda: _closed_pools(wallet))
    finally:
        await _record_usage(db, 1, 0)


async def position_flows(db, positions: list[dict[str, Any]]) -> None:
    """Attach what actually moved in and out of each position, from the cached Meteora events: dollars deposited,
    dollars withdrawn, fees claimed separately, and how many transactions it took."""
    if db is None or not positions:
        return
    rows = await db.fetch(
        """select position, event_type, sum(usd) as usd, count(*) as n,
                  sum(amount_x) as amount_x, sum(amount_y) as amount_y
           from portfolio_position_events where position = any($1::text[]) group by position, event_type""",
        [p["address"] for p in positions],
    )
    by_position: dict[str, dict[str, Any]] = {}
    for r in rows:
        by_position.setdefault(r["position"], {})[r["event_type"]] = r
    for p in positions:
        events = by_position.get(p["address"], {})
        add_row, remove_row, claim_row = events.get("add"), events.get("remove"), events.get("claim_fee")
        p["deposited_usd"] = float(add_row["usd"]) if add_row else None
        p["withdrawn_usd"] = float(remove_row["usd"]) if remove_row else None
        p["claimed_usd"] = float(claim_row["usd"]) if claim_row else 0.0
        p["tx_count"] = sum(int(r["n"]) for r in events.values())
        p["amount_x_in"] = float(add_row["amount_x"]) if add_row else None
        p["amount_y_in"] = float(add_row["amount_y"]) if add_row else None
        p["amount_x_out"] = float(remove_row["amount_x"]) if remove_row else None
        p["amount_y_out"] = float(remove_row["amount_y"]) if remove_row else None


async def range_behaviour(db, pool: str, positions: list[dict[str, Any]]) -> None:
    """Fill in how each position actually behaved inside its range, from the 30m candles this app stores.

    Meteora reports the result but not the story: a position can be green because it was closed early, or red
    because the price walked out the bottom hours before it was closed. `in_range_pct` says how much of its life
    the price was inside the range (fees only accrue there), and `exit_side` says where the price sat at the end.
    Candles are kept for about a week, so older positions simply get None.
    """
    if db is None or not positions:
        return
    spans = [(p["opened_at"], p["closed_at"]) for p in positions if p.get("opened_at") and p.get("closed_at")]
    if not spans:
        return
    rows = await db.fetch(
        """select (extract(epoch from ts) * 1000)::bigint as ts, close
           from candles where address = $1 and timeframe = '30m'
             and ts between to_timestamp($2 / 1000.0) and to_timestamp($3 / 1000.0)
           order by ts""",
        pool, min(a for a, _ in spans), max(b for _, b in spans),
    )
    candles = [(r["ts"], float(r["close"])) for r in rows]
    for p in positions:
        opened, closed = p.get("opened_at"), p.get("closed_at")
        lo, hi = p.get("min_price") or 0.0, p.get("max_price") or 0.0
        window = [c for ts, c in candles if opened and closed and opened <= ts <= closed] if lo and hi else []
        if not window:
            p["in_range_pct"] = None
            p["exit_side"] = None
            p["last_price"] = None
            continue
        inside = sum(1 for c in window if lo <= c <= hi)
        last = window[-1]
        p["in_range_pct"] = inside / len(window) * 100
        p["last_price"] = last
        p["exit_side"] = "below" if last < lo else "above" if last > hi else "inside"


async def closed_positions(db, wallet: str, pool: str) -> list[dict[str, Any]]:
    try:
        return await asyncio.to_thread(_cached, f"cpp:{wallet}:{pool}", False, lambda: _closed_positions(wallet, pool))
    finally:
        await _record_usage(db, 1, 0)


async def closed_orders(db, wallet: str, fresh: bool = False) -> list[dict[str, Any]]:
    try:
        return await asyncio.to_thread(_cached, f"co:{wallet}", fresh, lambda: _closed_orders(wallet))
    finally:
        await _record_usage(db, 1, 0)
