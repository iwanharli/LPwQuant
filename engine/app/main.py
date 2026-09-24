import logging
from contextlib import asynccontextmanager
from datetime import datetime
from zoneinfo import ZoneInfo

import time

from fastapi import FastAPI, HTTPException, Query, WebSocket
from fastapi.middleware.cors import CORSMiddleware

from . import config
from .backtest import default_params, run_backtest
from .charts import MAX_HOURS, load_candles, pool_paper_positions, profile_decision
from .freshness import check_freshness
from . import busy_hours, ledger, limit_recs, netpnl, panda, paper_lo, paper_pool, portfolio

log = logging.getLogger("api")
from .service import Engine

_tz = ZoneInfo(config.TIMEZONE)
logging.Formatter.converter = lambda *args: datetime.now(_tz).timetuple()
logging.basicConfig(level=logging.INFO, format="%(asctime)s WIB %(levelname)s %(name)s: %(message)s")

engine = Engine()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    await engine.start()
    yield
    await engine.stop()


app = FastAPI(title="quant engine", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_methods=["GET", "POST"],  # POST: the dashboard logs actions it sent (portfolio activity)
    allow_headers=["*"],
)


@app.get("/api/health")
async def health() -> dict:
    return {"ok": True, "pools": len(engine.rows), "updated_at": engine.updated_at}


@app.get("/api/pools")
async def pools(limit: int = Query(100, ge=1, le=1000)) -> dict:
    return {"updated_at": engine.updated_at, "pools": engine.sorted_rows()[:limit]}


@app.get("/api/pools/{address}")
async def pool_detail(address: str) -> dict:
    """One screener row plus how each risk profile would treat the pool now."""
    row = engine.rows.get(address)
    if row is None:
        raise HTTPException(status_code=404, detail="pool not in the screener")
    return {
        "updated_at": engine.updated_at,
        "pool": row,
        "profiles": [profile_decision(row, trader) for trader in engine.papers.values()],
    }


@app.get("/api/pools/{address}/candles")
async def pool_candles(
    address: str,
    tf: str = Query("30m", pattern="^(5m|30m|1h|4h)$"),
    hours: int | None = Query(None, ge=1, le=MAX_HOURS),
) -> dict:
    try:
        return await load_candles(engine.db, address, tf, hours)
    except Exception as err:  # upstream HTTP errors, timeouts
        raise HTTPException(status_code=502, detail=f"candles unavailable: {str(err)[:120]}") from err


@app.get("/api/pools/{address}/paper")
async def pool_paper(address: str) -> dict:
    if engine.db is None:
        raise HTTPException(status_code=503, detail="engine not ready")
    return {"positions": await pool_paper_positions(engine.db, address)}


@app.get("/api/portfolio")
async def get_portfolio(wallet: str, fresh: bool = False, days: int = Query(30, ge=1, le=180)) -> dict:
    """Read-only LP portfolio of a public wallet address, plus the daily profit from our own snapshots. Looking a
    wallet up registers it for snapshots, so the daily history starts from the first visit."""
    if engine.db is None:
        raise HTTPException(status_code=503, detail="engine not ready")
    if not portfolio.valid_wallet(wallet):
        raise HTTPException(status_code=400, detail="alamat wallet tidak valid")
    try:
        data = await portfolio.fetch_portfolio(engine.db, wallet, fresh=fresh)
    except Exception as err:
        raise HTTPException(status_code=502, detail=f"Meteora API gagal: {err}") from err
    await portfolio.add_wallet(engine.db, wallet)
    hist = await portfolio.history(engine.db, wallet, days)
    if not hist["series"]:
        await portfolio.snapshot(engine.db, data)  # first visit: start the history now, not in 15 minutes
        hist = await portfolio.history(engine.db, wallet, days)
    return {**data, **hist}


@app.get("/api/portfolio/orders")
async def get_orders(wallet: str, fresh: bool = False) -> dict:
    """Open Meteora limit orders of a public wallet address. Read-only."""
    if engine.db is None:
        raise HTTPException(status_code=503, detail="engine not ready")
    if not portfolio.valid_wallet(wallet):
        raise HTTPException(status_code=400, detail="alamat wallet tidak valid")
    try:
        return await portfolio.fetch_orders(engine.db, wallet, fresh=fresh)
    except Exception as err:
        raise HTTPException(status_code=502, detail=f"Meteora API gagal: {err}") from err


def _wallet_or_400(wallet: str) -> None:
    if engine.db is None:
        raise HTTPException(status_code=503, detail="engine not ready")
    if not portfolio.valid_wallet(wallet):
        raise HTTPException(status_code=400, detail="alamat wallet tidak valid")


@app.get("/api/portfolio/activity")
async def get_activity(
    wallet: str,
    limit: int = Query(50, ge=1, le=200),
    kind: str | None = None,
    before_ts: int | None = None,
    before_sig: str | None = None,
) -> dict:
    """One page of the wallet's history; pass the last row's ts and signature to get the next."""
    _wallet_or_400(wallet)
    cursor = (before_ts, before_sig) if before_ts is not None and before_sig else None
    items = await portfolio.list_activity(engine.db, wallet, limit, kind, cursor)
    return {"items": items, "has_more": len(items) == limit}


@app.post("/api/portfolio/activity")
async def post_activity(entry: dict) -> dict:
    """Actions the dashboard sent (claims, limit orders). Only what a signature can prove matters: the chain sync
    re-reads each one, so a wrong entry here cannot invent balances."""
    _wallet_or_400(str(entry.get("wallet") or ""))
    sigs = [s for s in entry.get("signatures") or [] if portfolio.valid_signature(str(s))]
    if not sigs or entry.get("kind") not in portfolio.ACTIVITY_KINDS:
        raise HTTPException(status_code=400, detail="signature atau jenis tidak valid")
    for sig in sigs[:50]:
        await portfolio.record_activity(engine.db, {**entry, "signature": sig})
    return {"recorded": len(sigs[:50])}


@app.get("/api/portfolio/networth")
async def get_networth(wallet: str, days: int = Query(30, ge=1, le=365)) -> dict:
    _wallet_or_400(wallet)
    return {"series": await portfolio.networth_history(engine.db, wallet, days)}


@app.get("/api/portfolio/position-history")
async def get_position_history(wallet: str, position: str, days: int = Query(30, ge=1, le=365)) -> dict:
    _wallet_or_400(wallet)
    return {"series": await portfolio.position_history(engine.db, wallet, position, days)}


@app.get("/api/busy-hours")
async def get_busy_hours(pool: str | None = None) -> dict:
    """When in the day (WIB) trading happens: one pool's profile with the market's beside it, or the market alone."""
    if engine.db is None:
        raise HTTPException(status_code=503, detail="engine not ready")
    if pool:
        return await busy_hours.pool_profile(engine.db, pool)
    return {"market": await busy_hours.market_profile(engine.db)}


@app.get("/api/portfolio/claims-daily")
async def get_claims_daily(wallet: str) -> dict:
    _wallet_or_400(wallet)
    return {"days": await portfolio.claims_daily(engine.db, wallet)}


@app.get("/api/portfolio/closed")
async def get_closed(wallet: str, pool: str | None = None, fresh: bool = False) -> dict:
    """Closed LP history from Meteora: every pool the wallet has closed positions in, or one pool's positions."""
    _wallet_or_400(wallet)
    try:
        if pool:
            positions = await portfolio.closed_positions(engine.db, wallet, pool)
            await portfolio.range_behaviour(engine.db, pool, positions)
            return {"positions": positions}
        return {"pools": await portfolio.closed_pools(engine.db, wallet, fresh)}
    except Exception as err:
        raise HTTPException(status_code=502, detail=f"Meteora API gagal: {err}") from err


@app.get("/api/portfolio/orders/closed")
async def get_closed_orders(wallet: str, fresh: bool = False) -> dict:
    _wallet_or_400(wallet)
    try:
        return {"orders": await portfolio.closed_orders(engine.db, wallet, fresh)}
    except Exception as err:
        raise HTTPException(status_code=502, detail=f"Meteora API gagal: {err}") from err


@app.get("/api/new-pools")
async def new_pools(max_age_hours: float = Query(1.0, gt=0, le=24), min_tvl: float = Query(500, ge=0)) -> dict:
    """Pools created within `max_age_hours` with at least `min_tvl`, newest first, each with the same safety verdict
    the Telegram new-pool alert uses, so the page and the alert never disagree."""
    from .alerts import safe_new_pool, top10_pct

    out = []
    for row in engine.sorted_rows():
        age = row.get("pool_age_hours")
        if age is None or age > max_age_hours or (row.get("tvl") or 0) < min_tvl:
            continue
        ok, reason = safe_new_pool({**row, "pool_age_hours": min(age, 23.9)})
        pending = not row.get("security")
        out.append({
            **{k: row.get(k) for k in ("address", "name", "base_symbol", "base_mint", "bin_step", "base_fee_pct", "tvl",
                                     "volume_24h", "fees_24h", "price", "change_pct_1h", "market_cap", "holders",
                                     "flags", "pool_age_hours")},
            "top10_pct": top10_pct(row),
            "verdict": "pending" if pending else ("ok" if ok else "blocked"),
            "reason": reason,
        })
    out.sort(key=lambda r: r["pool_age_hours"])
    return {"updated_at": engine.updated_at, "pools": out}


@app.get("/api/portfolio/ledger")
async def get_ledger(wallet: str) -> dict:
    """Capital, net worth and where the difference came from (LP, gacha, trading), in dollars and rupiah."""
    _wallet_or_400(wallet)
    try:
        return await ledger.summary(engine.db, wallet)
    except Exception as err:
        raise HTTPException(status_code=502, detail=f"gagal menghitung: {err}") from err


@app.post("/api/portfolio/capital")
async def post_capital(entry: dict) -> dict:
    """Capital the user remembers putting in (or taking out: negative), in rupiah or dollars."""
    wallet = str(entry.get("wallet") or "")
    _wallet_or_400(wallet)
    idr, usd_ = entry.get("amount_idr"), entry.get("amount_usd")
    if not isinstance(idr, (int, float)) and not isinstance(usd_, (int, float)):
        raise HTTPException(status_code=400, detail="isi jumlah dalam rupiah atau USD")
    ts = None
    if entry.get("date"):
        try:
            ts = datetime.fromisoformat(str(entry["date"])).replace(tzinfo=ZoneInfo(config.TIMEZONE))
        except ValueError as err:
            raise HTTPException(status_code=400, detail="tanggal tidak valid") from err
    await ledger.add_capital(engine.db, wallet, idr if isinstance(idr, (int, float)) else None,
                             usd_ if isinstance(usd_, (int, float)) else None, (entry.get("note") or None), ts)
    return {"ok": True}


@app.post("/api/portfolio/capital/delete")
async def delete_capital(entry: dict) -> dict:
    wallet = str(entry.get("wallet") or "")
    _wallet_or_400(wallet)
    await ledger.delete_capital(engine.db, wallet, int(entry.get("id") or 0))
    return {"ok": True}


@app.get("/api/limit-order/recommendations")
async def limit_order_recommendations() -> dict:
    """Safe, busy, sideways pools with buy/sell/stop levels from their own ATR and a 48-hour replay of that rule."""
    if engine.db is None:
        raise HTTPException(status_code=503, detail="engine not ready")
    recs = await limit_recs.recommendations(engine.db, engine.sorted_rows())
    return {"updated_at": engine.updated_at, "pools": recs, "stats": limit_recs.summary_stats(recs)}


@app.get("/api/limit-order/paper")
async def limit_order_paper() -> dict:
    """The engine's paper run of the recommended limit-order rule: every order and the running result."""
    if engine.db is None:
        raise HTTPException(status_code=503, detail="engine not ready")
    return await paper_lo.report(engine.db)


@app.get("/api/panda/paper")
async def get_panda_paper() -> dict:
    """Paper test of the Panda Strat: screening funnel, open and closed positions, and what each one cost."""
    return await panda.report(engine.db, engine.rows)


@app.get("/api/pool-lab/paper")
async def get_pool_lab_paper() -> dict:
    """Paper test of creating DLMM pools: joins new high-fee pools as their first LP and follows the result."""
    return await paper_pool.report(engine.db)


@app.get("/api/portfolio/netpnl")
async def get_netpnl(wallet: str, fresh: bool = False) -> dict:
    """Net result per coin and per position by cash-flow accounting, reconciled with the ledger's total."""
    _wallet_or_400(wallet)
    try:
        return await netpnl.compute(engine.db, wallet, fresh)
    except Exception as err:
        log.exception("netpnl failed")
        raise HTTPException(status_code=502, detail=f"gagal menghitung: {err}") from err


@app.get("/api/portfolio/position-costs")
async def get_position_costs(wallet: str) -> dict:
    """Costs and net result per position, from the same accounting as the net view, for the position-history table."""
    _wallet_or_400(wallet)
    try:
        data = await netpnl.compute(engine.db, wallet)
    except Exception as err:
        raise HTTPException(status_code=502, detail=f"gagal menghitung: {err}") from err
    out = {}
    for c in data["coins"]:
        for p in c["positions"]:
            out[p["position"]] = {"pool": p["pool"], "cost_lp": p["cost_lp"], "cost_swaps": p["cost_swaps"], "net": p["net"], "swaps": p["swaps"]}
    return {"positions": out, "costs_known_txs": data["costs"]["costs_known_txs"], "transactions": data["costs"]["transactions"]}


@app.get("/api/usage")
async def usage() -> dict:
    return await engine.usage_summary()


@app.get("/api/backtest")
async def backtest(
    hours: float = Query(24, gt=0, le=168),
    every: float = Query(60, ge=15, le=720, description="minutes between entries per pool"),
    source: str = Query("candles", pattern="^(candles|snapshots)$"),
) -> dict:
    # CPU work runs on the event loop; fine for occasional manual runs.
    assert engine.db
    return await run_backtest(engine.db, hours, every, default_params(), source)


@app.get("/api/freshness")
async def freshness() -> dict:
    if engine.db is None:
        raise HTTPException(status_code=503, detail="engine not ready")
    return await check_freshness(engine.db, int(time.time() * 1000))


def _paper(profile: str = "moderat"):
    if not engine.papers:
        raise HTTPException(status_code=503, detail="paper trading not ready")
    trader = engine.papers.get(profile)
    if trader is None:
        raise HTTPException(status_code=404, detail=f"unknown profile: {profile}")
    return trader


@app.get("/api/paper/profiles")
async def paper_profiles() -> dict:
    """Side-by-side headline numbers for every risk profile."""
    if not engine.papers:
        raise HTTPException(status_code=503, detail="paper trading not ready")
    return {"profiles": [await trader.compare_summary() for trader in engine.papers.values()]}


@app.post("/api/paper/reset")
async def paper_reset() -> dict:
    """Delete all paper positions and equity history for every profile and restart from the starting equity."""
    if not engine.papers:
        raise HTTPException(status_code=503, detail="paper trading not ready")
    return {"deleted": await engine.reset_papers()}


@app.get("/api/paper/summary")
async def paper_summary(profile: str = Query("moderat")) -> dict:
    return await _paper(profile).summary()


@app.get("/api/paper/positions")
async def paper_positions(
    status: str = Query("open", pattern="^(open|closed)$"),
    limit: int = Query(100, ge=1, le=500),
    profile: str = Query("moderat"),
) -> dict:
    return {"positions": await _paper(profile).positions(status, limit, int(time.time() * 1000))}


@app.get("/api/paper/equity")
async def paper_equity(hours: float = Query(168, gt=0, le=24 * 60), profile: str = Query("moderat")) -> dict:
    return await _paper(profile).equity(hours)


@app.websocket("/ws")
async def ws(websocket: WebSocket) -> None:
    await websocket.accept()
    queue = engine.subscribe()
    try:
        await websocket.send_json(engine.snapshot_message())
        while (message := await queue.get()) is not None:
            await websocket.send_json(message)
        await websocket.close(code=1013)  # server dropped a slow client
    except Exception:
        pass  # client disconnected
    finally:
        engine.unsubscribe(queue)
