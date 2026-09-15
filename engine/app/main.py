import logging
from contextlib import asynccontextmanager
from datetime import datetime
from zoneinfo import ZoneInfo

import time

from fastapi import FastAPI, HTTPException, Query, WebSocket
from fastapi.middleware.cors import CORSMiddleware

from . import config
from .backtest import default_params, run_backtest
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


def _paper():
    if engine.paper is None:
        raise HTTPException(status_code=503, detail="paper trading not ready")
    return engine.paper


@app.get("/api/paper/summary")
async def paper_summary() -> dict:
    return await _paper().summary()


@app.get("/api/paper/positions")
async def paper_positions(
    status: str = Query("open", pattern="^(open|closed)$"),
    limit: int = Query(100, ge=1, le=500),
) -> dict:
    return {"positions": await _paper().positions(status, limit, int(time.time() * 1000))}


@app.get("/api/paper/equity")
async def paper_equity(hours: float = Query(168, gt=0, le=24 * 60)) -> dict:
    return await _paper().equity(hours)


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
