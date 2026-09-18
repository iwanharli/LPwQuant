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
from . import portfolio
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
    allow_methods=["GET"],
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
