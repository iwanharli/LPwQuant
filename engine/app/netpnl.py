"""Net result per coin and per LP position, by cash-flow accounting over the wallet's full transaction history.

Meteora's position PnL covers what happens inside a position. What a coin actually made or lost also includes the
swaps that bought the token before the position and sold it after, limit orders, network fees, and whatever is
still held. Here every transaction is assigned to one coin and its SOL/USDC movement is summed:

    net of a coin = SOL and USDC received - SOL and USDC spent (all its transactions) + value still held of it

  * SOL is valued in dollars at the time of each transaction (30-minute SOL-USDC candles), USDC at $1.
  * An LP transaction is assigned by its signature: Meteora's per-position event history names the pool, which a
    single-sided SOL deposit's balance changes cannot. Everything else goes by the memecoin it moved.
  * Network fees and account rent are inside each transaction's SOL change, so they are counted where they occur.
  * Held value: tokens in the wallet, open positions and open limit orders, at today's prices.

Per position: Meteora's PnL of the position (tokens valued as they enter and leave it, so tokens rolled from one
position into the next do not distort it) plus a share of the coin's result outside LP, split by the swap volume
around each position. The coin totals are exact; the per-position split of the outside part is a rule and says so.

The result is reconciled with the ledger's total (net worth now - capital): coins + gacha + SOL/USDC conversions +
unassigned = total, and whatever is left is the effect of the SOL price on SOL held, shown as its own line.
"""

import asyncio
import bisect
import json
import logging
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Any

from . import config, ledger, portfolio

log = logging.getLogger("netpnl")

SOL = "So11111111111111111111111111111111111111112"
USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
QUOTES = {SOL, USDC}
CACHE_S = 300
_cache: dict[str, tuple[float, dict[str, Any]]] = {}


# ---- Positions and their events (Meteora), cached in the database ----------------------------------------------

async def sync_positions(db, wallet: str) -> None:
    """Index every position (closed and open) with its pool's mints, and fetch the events of positions whose events
    are missing or still changing (open, or closed after the last fetch)."""
    closed_pools = await portfolio.closed_pools(db, wallet)
    open_pf = await portfolio.fetch_portfolio(db, wallet)
    now = datetime.now(timezone.utc)
    positions: list[tuple] = []
    # A pool whose newest close is already indexed has nothing new: skip its per-position call (100+ pools otherwise
    # cost ~25 s on every recompute).
    known = {
        r["pool"]: int(r["last"].timestamp() * 1000)
        for r in await db.fetch(
            "select pool, max(closed_at) as last from portfolio_positions_index where wallet = $1 and status = 'closed' group by pool",
            wallet,
        )
        if r["last"]
    }
    # Pools whose indexed positions are still missing their price range (added later than the rest of the index)
    # are fetched again even when nothing has closed since.
    incomplete = {
        r["pool"]
        for r in await db.fetch(
            """select distinct pool from portfolio_positions_index
               where wallet = $1 and status = 'closed' and min_price is null""",
            wallet,
        )
    }
    for p in closed_pools:
        if p.get("closed_at") and known.get(p["address"], 0) >= p["closed_at"] and p["address"] not in incomplete:
            continue
        for q in await portfolio.closed_positions(db, wallet, p["address"]):
            positions.append((q["address"], p["address"], p.get("mint_x"), p.get("mint_y"), p.get("token_x"), p.get("token_y"),
                              q["opened_at"], q["closed_at"], "closed", q["pnl_usd"], q["fees_usd"], q["deposit_usd"],
                              q.get("min_price"), q.get("max_price")))
    for p in open_pf["pools"]:
        for q in p["positions"]:
            positions.append((q["address"], p["address"], p.get("mint_x"), p.get("mint_y"), p.get("token_x"), p.get("token_y"),
                              q["created_at"], None, "open", q["pnl_usd"], q.get("fees_usd"), q.get("deposit_usd"),
                              q.get("min_price"), q.get("max_price")))
    to_dt = lambda ms: datetime.fromtimestamp(ms / 1000, timezone.utc) if ms else None  # noqa: E731
    for (pos, pool, mx, my, sx, sy, opened, closed, status, pnl, fees, dep, lo, hi) in positions:
        await db.execute(
            """insert into portfolio_positions_index (position, wallet, pool, mint_x, mint_y, symbol_x, symbol_y, opened_at,
                 closed_at, status, meteora_pnl_usd, fees_usd, deposit_usd, min_price, max_price)
               values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
               on conflict (position) do update set status = excluded.status, closed_at = excluded.closed_at,
                 meteora_pnl_usd = excluded.meteora_pnl_usd, fees_usd = excluded.fees_usd, deposit_usd = excluded.deposit_usd,
                 mint_x = coalesce(excluded.mint_x, portfolio_positions_index.mint_x),
                 mint_y = coalesce(excluded.mint_y, portfolio_positions_index.mint_y),
                 min_price = coalesce(excluded.min_price, portfolio_positions_index.min_price),
                 max_price = coalesce(excluded.max_price, portfolio_positions_index.max_price)""",
            pos, wallet, pool, mx, my, sx, sy, to_dt(opened), to_dt(closed), status, pnl, fees, dep, lo, hi,
        )
    stale = await db.fetch(
        """select position from portfolio_positions_index where wallet = $1 and
             (events_fetched_at is null or status = 'open' or closed_at > events_fetched_at)""",
        wallet,
    )
    for r in stale:
        try:
            events = await asyncio.to_thread(portfolio._get, f"/positions/{r['position']}/historical", {})
        except Exception as err:  # one position failing must not stop the rest
            log.warning("events for %s failed: %s", r["position"][:6], err)
            continue
        rows = [
            (e["signature"], r["position"], e.get("poolAddress") or "", e.get("eventType") or "?",
             datetime.fromtimestamp((e.get("blockTime") or 0) / 1000, timezone.utc),
             portfolio._f(e.get("amountX")), portfolio._f(e.get("amountY")), portfolio._f(e.get("totalUsd")))
            for e in events.get("events") or [] if e.get("signature")
        ]
        if rows:
            await db.executemany(
                """insert into portfolio_position_events (signature, position, pool, event_type, ts, amount_x, amount_y, usd)
                   values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict do nothing""",
                rows,
            )
        await db.execute("update portfolio_positions_index set events_fetched_at = $2 where position = $1", r["position"], now)
        await asyncio.sleep(0.15)


# ---- Prices ------------------------------------------------------------------------------------------------------

async def _sol_prices(db) -> tuple[list[float], list[float]]:
    """(timestamps, SOL/USD closes) from the deepest SOL-USDC pool's 30-minute candles."""
    pool = await db.fetchval(
        """select c.address from candles c join pools p on p.address = c.address
           where p.name in ('SOL-USDC', 'WSOL-USDC') and c.timeframe = '30m' group by 1 order by count(*) desc limit 1"""
    )
    if not pool:
        return [], []
    rows = await db.fetch("select ts, close from candles where address = $1 and timeframe = '30m' order by ts", pool)
    return [r["ts"].timestamp() for r in rows], [r["close"] for r in rows]


def _price_at(ts: float, times: list[float], closes: list[float], fallback: float) -> float:
    if not times:
        return fallback
    i = bisect.bisect_right(times, ts) - 1
    return closes[max(0, i)]


def _get_json(url: str) -> Any:
    try:
        with urllib.request.urlopen(url, timeout=60) as r:
            return json.load(r)
    except (urllib.error.URLError, TimeoutError, ValueError):
        return None


# ---- Accounting --------------------------------------------------------------------------------------------------

def _deltas(row) -> list[dict[str, Any]]:
    return row["deltas"] if isinstance(row["deltas"], list) else json.loads(row["deltas"] or "[]")


async def _data_version(db, wallet: str) -> tuple:
    """Changes whenever a transaction arrives or is updated (costs filled, reclassified): the cache must not outlive
    it, or a position closed a minute ago shows its entry but not its exit."""
    r = await db.fetchrow(
        """select count(*) as n, max(ts) as last, count(network_fee_lamports) as costed,
                  (select count(*) from portfolio_positions_index where wallet = $1 and status = 'open') as open
           from portfolio_activity where wallet = $1""",
        wallet,
    )
    return (r["n"], r["last"], r["costed"], r["open"])


NET_REFRESH_S = 600


async def refresh_loop(db) -> None:
    """Recompute every registered wallet's net result in the background, so the pages that read the stored numbers
    find them fresh. Without this the first visitor after a restart pays the full ~45s accounting."""
    while True:
        try:
            for r in await db.fetch("select address from portfolio_wallets"):
                try:
                    await compute(db, r["address"])
                except Exception as err:
                    log.warning("netpnl refresh failed for %s...: %s", r["address"][:4], err)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("netpnl refresh round failed")
        await asyncio.sleep(NET_REFRESH_S)


async def compute(db, wallet: str, fresh: bool = False) -> dict[str, Any]:
    if fresh:
        # Pull the newest transactions first (the ingestor syncs every 5 minutes otherwise).
        await asyncio.to_thread(_get_json, f"{config.CLAIM_SERVER_URL}/history/sync?{urllib.parse.urlencode({'owner': wallet})}")
    version = await _data_version(db, wallet)
    hit = _cache.get(wallet)
    if hit and not fresh and time.time() - hit[0] < CACHE_S and hit[1].get("_version") == version:
        return hit[1]
    await sync_positions(db, wallet)

    idx = {r["position"]: dict(r) for r in await db.fetch("select * from portfolio_positions_index where wallet = $1", wallet)}
    ev_rows = await db.fetch(
        """select e.signature, e.position, e.pool, e.event_type from portfolio_position_events e
           join portfolio_positions_index i on i.position = e.position where i.wallet = $1""",
        wallet,
    )
    sig_pos: dict[str, str] = {}
    for e in ev_rows:
        sig_pos.setdefault(e["signature"], e["position"])
    pool_mint = {i["pool"]: (i["mint_x"], i["symbol_x"]) for i in idx.values()}

    times, closes = await _sol_prices(db)
    pf = await portfolio.fetch_portfolio(db, wallet)
    sol_now = pf["summary"].get("sol_price") or (closes[-1] if closes else config.SOL_USD_FALLBACK)

    acts = await db.fetch(
        """select signature, ts, kind, sol_delta, deltas, network_fee_lamports, pool_fees, other_dex_swap
           from portfolio_activity where wallet = $1 and ok order by ts""",
        wallet,
    )
    gacha_times = [a["ts"] for a in acts if a["kind"] == "gacha"]
    coins: dict[str, dict[str, Any]] = {}
    buckets = {"capital": 0.0, "gacha": 0.0, "conversion": 0.0, "unassigned": 0.0}
    unassigned_count = multi = 0

    totals = {"network": 0.0, "pool_fees": 0.0, "other_dex_swaps": 0, "unpriced_fees": 0, "costs_known_txs": 0}

    def coin(mint: str, symbol: str) -> dict[str, Any]:
        return coins.setdefault(mint, {
            "mint": mint, "symbol": symbol, "cash": 0.0, "qty": 0.0, "txs": [],
            "costs": {"network": 0.0, "pool_fees": 0.0, "total": 0.0, "other_dex_swaps": 0},
            "by": {"swap_buy": 0.0, "swap_sell": 0.0, "lp_in": 0.0, "lp_out": 0.0, "fees": 0.0, "orders": 0.0, "other": 0.0},
        })

    for a in acts:
        ds = _deltas(a)
        sol = (a["sol_delta"] or 0.0) + sum(d["amount"] for d in ds if d["mint"] == SOL)
        usdc = sum(d["amount"] for d in ds if d["mint"] == USDC)
        cash = usdc + sol * _price_at(a["ts"].timestamp(), times, closes, sol_now)
        tokens = [d for d in ds if d["mint"] not in QUOTES]
        sol_px = _price_at(a["ts"].timestamp(), times, closes, sol_now)
        # Costs are already inside `cash` (they reduced what came back or raised what went out); they are pulled out
        # here only to be shown. Network fee: exact. Pool fee: exact for Meteora swaps, priced in dollars at the
        # transaction's own rate when paid in a memecoin.
        network = (a["network_fee_lamports"] or 0) / 1e9 * sol_px
        pool_fee = 0.0
        for f in (a["pool_fees"] if isinstance(a["pool_fees"], list) else json.loads(a["pool_fees"] or "[]")):
            if f["mint"] == SOL:
                pool_fee += f["amount"] * sol_px
            elif f["mint"] == USDC:
                pool_fee += f["amount"]
            else:
                # Priced at the transaction's own rate. When the swap happens inside the transaction (a rebalance or a
                # zap), little of the token ends up moving and that rate is meaningless; a fee worth more than 10% of
                # the money that moved is such a case, and is counted as unpriced rather than guessed.
                moved = sum(abs(d["amount"]) for d in ds if d["mint"] == f["mint"])
                value = f["amount"] * abs(cash) / moved if moved > 0 and abs(cash) > 0 else None
                if value is not None and value <= 0.1 * abs(cash):
                    pool_fee += value
                else:
                    totals["unpriced_fees"] += 1
        totals["network"] += network
        totals["pool_fees"] += pool_fee
        totals["other_dex_swaps"] += bool(a["other_dex_swap"])
        totals["costs_known_txs"] += a["network_fee_lamports"] is not None
        pos = sig_pos.get(a["signature"])
        if pos and idx[pos]["mint_x"]:
            mint, symbol = idx[pos]["mint_x"], idx[pos]["symbol_x"] or "?"
        elif tokens:
            main = max(tokens, key=lambda d: abs(d["amount"]))
            mint, symbol = main["mint"], main["symbol"]
            multi += len(tokens) > 1
        else:
            mint = None
        if mint is None:
            if a["kind"] in ("deposit", "withdraw") and not ledger.gacha_related(a["ts"], cash, gacha_times):
                buckets["capital"] += cash
            elif a["kind"] == "gacha" or ledger.gacha_related(a["ts"], cash, gacha_times):
                buckets["gacha"] += cash
            elif a["kind"] == "swap":
                buckets["conversion"] += cash  # SOL <-> USDC: only the cost of converting stays
            else:
                buckets["unassigned"] += cash
                unassigned_count += 1
            continue
        c = coin(mint, symbol)
        c["cash"] += cash
        c["costs"]["network"] += network
        c["costs"]["pool_fees"] += pool_fee
        c["costs"]["total"] += network + pool_fee
        c["costs"]["other_dex_swaps"] += bool(a["other_dex_swap"])
        for d in tokens:
            if d["mint"] == mint:
                c["qty"] += d["amount"]
        k = a["kind"]
        cat = ("swap_buy" if cash < 0 else "swap_sell") if k == "swap" else {
            "add_liquidity": "lp_in", "rebalance": "lp_in" if cash < 0 else "lp_out", "remove_liquidity": "lp_out",
            "claim": "fees", "limit_order_place": "orders", "limit_order_cancel": "orders",
        }.get(k, "other")
        c["by"][cat] += cash
        c["txs"].append({"sig": a["signature"], "ts": a["ts"].timestamp(), "cash": cash, "kind": k, "position": pos,
                         "cost": network + pool_fee,
                         "qty": sum(d["amount"] for d in tokens if d["mint"] == mint)})

    # Held value today: wallet tokens, open positions, open limit orders.
    wallet_now = await asyncio.to_thread(_get_json, f"{config.CLAIM_SERVER_URL}/wallet?{urllib.parse.urlencode({'owner': wallet})}")
    held_wallet = {t["mint"]: (t.get("value_usd") or 0.0, t.get("symbol")) for t in (wallet_now or {}).get("tokens", [])}
    for mint, (value, symbol) in held_wallet.items():
        if mint in QUOTES or mint not in coins:
            continue
        coins[mint]["held_wallet"] = value
    for p in pf["pools"]:
        mint = p.get("mint_x")
        if mint in coins:
            coins[mint]["held_lp"] = coins[mint].get("held_lp", 0.0) + p["value_usd"] + p["unclaimed_fees_usd"]
    try:
        orders = await portfolio.fetch_orders(db, wallet)
        for p in orders["pools"]:
            mint = pool_mint.get(p["address"], (None, None))[0]
            if mint in coins:
                coins[mint]["held_orders"] = coins[mint].get("held_orders", 0.0) + sum(
                    o["unfilled_usd"] + o["filled_output_usd"] + o["bonus_usd"] for o in p["orders"]
                )
    except Exception:
        pass

    out_coins = []
    stored: list[tuple[str, float, float, float]] = []
    for c in coins.values():
        held = c.get("held_wallet", 0.0) + c.get("held_lp", 0.0) + c.get("held_orders", 0.0)
        c["held"] = held
        c["net"] = c["cash"] + held
        c["positions"] = _split_positions(c, [i for i in idx.values() if i["mint_x"] == c["mint"]])
        stored.extend(
            (p["position"], p["cost_lp"], p["cost_swaps"], p["net"]) for p in c["positions"]
        )
        c.pop("txs")
        out_coins.append(c)
    out_coins.sort(key=lambda c: c["net"])

    # Keep the per-position result in the index: the history page then reads it from the database in milliseconds
    # instead of triggering this whole accounting.
    if stored:
        await db.executemany(
            """update portfolio_positions_index set cost_lp = $2, cost_swaps = $3, net_usd = $4, net_at = now()
               where position = $1""",
            stored,
        )

    ld = await ledger.summary(db, wallet)
    coins_total = sum(c["net"] for c in out_coins)
    explained = coins_total + buckets["gacha"] + buckets["conversion"] + buckets["unassigned"]
    quote_now = sum(v for m, (v, _) in held_wallet.items() if m in QUOTES)
    result = {
        "sol_price_now": sol_now,
        "total_pl_usd": ld["pl"]["usd"],
        "coins_total_usd": coins_total,
        "buckets": {**buckets, "sol_price_effect": ld["pl"]["usd"] - explained},
        "costs": {**totals, "total": totals["network"] + totals["pool_fees"], "transactions": len(acts)},
        "checks": {"unassigned_transactions": unassigned_count, "multi_token_transactions": multi,
                   "quote_held_usd": quote_now, "positions_indexed": len(idx),
                   "lp_transactions_matched": sum(1 for s in sig_pos)},
        "coins": out_coins,
    }
    result["_version"] = version
    result["computed_at"] = int(time.time() * 1000)
    _cache[wallet] = (time.time(), result)
    return result


def _nearest(ps: list[dict[str, Any]], ts: float) -> str:
    """The position a swap at `ts` belongs to: the one open at that moment, else the one whose open or close is
    closest in time (a buy just before opening, a sell just after closing). Positions opened back to back no longer
    swallow each other's swaps, as a fixed window after each close did."""
    def distance(p: dict[str, Any]) -> float:
        opened = p["opened_at"].timestamp() if p["opened_at"] else float("-inf")
        closed = p["closed_at"].timestamp() if p["closed_at"] else float("inf")
        if opened <= ts <= closed:
            return 0.0
        return opened - ts if ts < opened else ts - closed
    return min(ps, key=lambda p: (distance(p), -(p["opened_at"].timestamp() if p["opened_at"] else 0)))["position"]


def _split_positions(c: dict[str, Any], positions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """A coin's net over its positions.

    Splitting cash by position misleads when tokens roll from one position into the next (a rebalance moves GP out
    of one position and into another without selling it): the first looks like a big loss, the last like a big gain.
    So each position starts from Meteora's own PnL, which values tokens at the moment they enter and leave the
    position, and the coin's result outside LP (coin net - sum of Meteora PnL: swap costs, tokens that lost value
    after leaving, what is still held) is shared out by the swap volume around each position (see _nearest). Positions add up to the coin exactly."""
    if not positions:
        return []
    ps = sorted(positions, key=lambda p: (p["closed_at"] or datetime.max.replace(tzinfo=timezone.utc)))
    volume = {p["position"]: 0.0 for p in ps}
    count = {p["position"]: 0 for p in ps}
    cost_lp = {p["position"]: 0.0 for p in ps}
    cost_swaps = {p["position"]: 0.0 for p in ps}
    for t in c["txs"]:
        if t.get("position") in cost_lp:
            cost_lp[t["position"]] += t.get("cost", 0.0)  # the position's own transactions, by signature
            continue
        target = _nearest(ps, t["ts"])
        cost_swaps[target] += t.get("cost", 0.0)
        if t["kind"] != "swap":
            continue
        volume[target] += abs(t["cash"])
        count[target] += 1
    meteora_total = sum(p["meteora_pnl_usd"] or 0.0 for p in ps)
    outside = c["net"] - meteora_total
    total_volume = sum(volume.values())
    deposits = sum(max(p["deposit_usd"] or 0.0, 0.0) for p in ps)
    out = []
    for p in ps:
        if total_volume > 0:
            weight = volume[p["position"]] / total_volume
        elif deposits > 0:
            weight = max(p["deposit_usd"] or 0.0, 0.0) / deposits
        else:
            weight = 1 / len(ps)
        share = outside * weight
        out.append({
            "position": p["position"],
            "pool": p["pool"],
            "status": p["status"],
            "opened_at": int(p["opened_at"].timestamp() * 1000) if p["opened_at"] else None,
            "closed_at": int(p["closed_at"].timestamp() * 1000) if p["closed_at"] else None,
            "meteora_pnl_usd": p["meteora_pnl_usd"],
            "fees_usd": p["fees_usd"],
            "deposit_usd": p["deposit_usd"],
            "swaps": count[p["position"]],
            "swap_volume": volume[p["position"]],
            "outside_share": share,
            "cost_lp": cost_lp[p["position"]],
            "cost_swaps": cost_swaps[p["position"]],
            "net": (p["meteora_pnl_usd"] or 0.0) + share,
        })
    return out
