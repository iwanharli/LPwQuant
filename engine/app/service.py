import asyncio
import json
import logging
import math
import time
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any

import asyncpg
import redis.asyncio as aioredis

from . import config
from .indicators import Candle, compute_indicators, flow_features, merge_market
from .metrics import PriceHistory
from .paper import PaperTrader, sol_usd_from_pools
from .depth import Depth, depth_per_bin_y, fee_for_position_pct_day, new_bin_arrays, window_bins
from .backtest import LpPosition
from .costs import round_trip_cost_pct
from .profiles import PROFILES, paper_config
from .recommend import PlanParams, apply_cost_gate, bins_below, bins_for_width, plan_position
from .scoring import base_token, expected_fee_pct_day, score_pool

log = logging.getLogger("engine")

HOUR_MS = 3_600_000
TICK_BROADCAST_INTERVAL_SEC = 1.0
CLIENT_QUEUE_SIZE = 200


def _clean(value: Any) -> Any:
    """JSON-safe floats (NaN/inf -> None), recursively."""
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, dict):
        return {k: _clean(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_clean(v) for v in value]
    return value


def _security_summary(security: dict[str, Any] | None) -> dict[str, Any] | None:
    if security is None:
        return None
    keys = (
        "score_normalised", "rugged", "mint_authority", "freeze_authority", "top10_pct",
        "insiders_detected", "total_holders", "lp_locked_pct", "danger_count", "warn_count", "fetched_at",
    )
    summary = {k: _clean(security.get(k)) for k in keys}
    summary["risks"] = [f"{r['name']} ({r['level']})" for r in security.get("risks", [])]
    return summary


class Engine:
    def __init__(self) -> None:
        self.redis: aioredis.Redis | None = None
        self.db: asyncpg.Pool | None = None
        self.histories: defaultdict[str, PriceHistory] = defaultdict(PriceHistory)
        self.last_tick_ms: dict[str, int] = {}
        self.pools: dict[str, dict[str, Any]] = {}
        self.security: dict[str, dict[str, Any]] = {}
        self.market: dict[str, dict[str, Any] | None] = {}
        self.insights: dict[str, dict[str, Any]] = {}
        self.paper: PaperTrader | None = None  # default profile: its cost model prices live plans
        self.papers: dict[str, PaperTrader] = {}  # one virtual account per risk profile (app.profiles)
        self._paper_lock = asyncio.Lock()  # paper updates and resets never interleave
        self.depth: dict[str, Depth] = {}  # on-chain bin liquidity around the active bin (bins:latest)
        self.rows: dict[str, dict[str, Any]] = {}
        self.plan_params = PlanParams(
            portfolio_usd=config.PORTFOLIO_USD,
            max_position_pct=config.MAX_POSITION_PCT,
            hold_hours=config.HOLD_HOURS,
            min_hold_hours=config.MIN_HOLD_HOURS,
            min_fee_cost_ratio=config.MIN_FEE_COST_RATIO,
            fee_gate_hours=config.FEE_GATE_HOURS,
        )
        self.sol_usd: float | None = None
        self.position_usd = config.PORTFOLIO_USD * config.MAX_POSITION_PCT / 100
        self.updated_at: int | None = None
        self._clients: set[asyncio.Queue[dict[str, Any] | None]] = set()
        self._tasks: list[asyncio.Task[None]] = []

    # lifecycle

    async def start(self) -> None:
        # No socket_timeout: Redis may return an expired XREAD BLOCK well after the block time
        # (seen 20s+ locally), which a client-side read timeout turns into spurious errors.
        # New stream entries still wake the reader immediately; keepalive catches dead sockets.
        self.redis = aioredis.from_url(
            config.REDIS_URL, decode_responses=True, socket_timeout=None, socket_keepalive=True
        )
        self.db = await asyncpg.create_pool(
            config.DATABASE_URL,
            min_size=1,
            max_size=4,
            server_settings={"timezone": config.TIMEZONE},
            **config.DB_CONNECT_KWARGS,
        )
        async with self.db.acquire() as conn:
            await conn.execute(config.SCHEMA_PATH.read_text())
        for profile in PROFILES:
            if profile.key not in config.PAPER_PROFILES:
                continue
            trader = PaperTrader(self.db, paper_config(profile))
            await trader.load()
            self.papers[profile.key] = trader
        self.paper = self.papers.get("moderat") or next(iter(self.papers.values()), None)
        await self._backfill()
        await self._refresh_pools()
        self._tasks = [
            asyncio.create_task(self._consume_pools(), name="consume_pools"),
            asyncio.create_task(self._consume_prices(), name="consume_prices"),
        ]
        log.info("engine started with %d pools", len(self.pools))

    async def stop(self) -> None:
        for task in self._tasks:
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        for queue in list(self._clients):
            self._close_client(queue)
        if self.redis:
            await self.redis.aclose()
        if self.db:
            await self.db.close()

    # websocket fan-out

    def subscribe(self) -> asyncio.Queue[dict[str, Any] | None]:
        queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue(maxsize=CLIENT_QUEUE_SIZE)
        self._clients.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue[dict[str, Any] | None]) -> None:
        self._clients.discard(queue)

    def _close_client(self, queue: asyncio.Queue[dict[str, Any] | None]) -> None:
        self._clients.discard(queue)
        while not queue.empty():
            queue.get_nowait()
        queue.put_nowait(None)

    def _broadcast(self, message: dict[str, Any]) -> None:
        for queue in list(self._clients):
            try:
                queue.put_nowait(message)
            except asyncio.QueueFull:
                log.warning("dropping slow websocket client")
                self._close_client(queue)

    def snapshot_message(self) -> dict[str, Any]:
        return {"type": "snapshot", "updated_at": self.updated_at, "pools": self.sorted_rows()}

    def sorted_rows(self) -> list[dict[str, Any]]:
        return sorted(self.rows.values(), key=lambda r: r["score"], reverse=True)

    # data

    async def usage_summary(self) -> dict[str, Any]:
        """RPC usage per provider/kind with a 30-day projection from the rate over the last 24h."""
        assert self.db
        rows = await self.db.fetch(
            """
            select provider, kind,
                   sum(count) filter (where hour >= now() - interval '24 hours') as last_24h,
                   sum(count) filter (where hour >= date_trunc('hour', now())) as this_hour,
                   sum(count) filter (where hour >= date_trunc('month', now())) as this_month,
                   min(first_at) filter (where hour >= now() - interval '24 hours') as first_at
            from rpc_usage
            where hour >= now() - interval '40 days'
            group by provider, kind
            order by provider, kind
            """
        )
        now = datetime.now(timezone.utc)
        items = []
        for r in rows:
            last_24h = int(r["last_24h"] or 0)
            first_at = r["first_at"] or (now - timedelta(hours=24))
            window_start = max(first_at, now - timedelta(hours=24))
            hours = max((now - window_start).total_seconds() / 3600, 1 / 60)
            # Subscriptions are one-off per pool, so a rate projection would be meaningless.
            projected = None if r["kind"] == "ws_subscribe" else round(last_24h / hours * 24 * 30)
            items.append({
                "provider": r["provider"],
                "kind": r["kind"],
                "this_hour": int(r["this_hour"] or 0),
                "last_24h": last_24h,
                "this_month": int(r["this_month"] or 0),
                "hours_covered": round(hours, 2),
                "projected_30d": projected,
            })
        return {"generated_at": int(now.timestamp() * 1000), "items": items}

    async def _load_market(self, addresses: list[str]) -> None:
        """Indicators from the latest 30m candles plus the latest buy/sell flow, per pool."""
        assert self.db and self.redis
        rows = await self.db.fetch(
            """
            select address, (extract(epoch from ts) * 1000)::bigint as ts_ms, open, high, low, close, volume
            from candles
            where timeframe = '30m' and ts > now() - interval '52 hours' and address = any($1::text[])
            order by address, ts
            """,
            addresses,
        )
        candles: defaultdict[str, list[Candle]] = defaultdict(list)
        for r in rows:
            candles[r["address"]].append(Candle(r["ts_ms"], r["open"], r["high"], r["low"], r["close"], r["volume"]))
        flow_raw = await self.redis.hgetall(config.KEY_FLOW_LATEST)
        self.market = {
            address: merge_market(
                compute_indicators(candles.get(address, [])),
                flow_features(json.loads(flow_raw[address])) if address in flow_raw else None,
            )
            for address in addresses
        }

    async def _backfill(self) -> None:
        """Rebuild in-memory price history from the DB so metrics survive restarts."""
        assert self.db
        secs = config.HISTORY_MS / 1000
        rows = await self.db.fetch(
            """
            select address, (extract(epoch from ts) * 1000)::bigint as ts_ms, price, true as is_tick
            from price_ticks where ts > now() - make_interval(secs => $1)
            union all
            select s.address, (extract(epoch from s.ts) * 1000)::bigint, s.price, false
            from pool_snapshots s
            where s.ts > now() - make_interval(secs => $1)
              and not exists (
                select 1 from price_ticks t
                where t.address = s.address and t.ts > now() - make_interval(secs => $1))
            order by ts_ms
            """,
            secs,
        )
        for r in rows:
            self.histories[r["address"]].add(r["ts_ms"], r["price"], config.HISTORY_MS)
            if r["is_tick"]:
                self.last_tick_ms[r["address"]] = r["ts_ms"]
        log.info("backfilled %d price points", len(rows))

    async def _refresh_pools(self) -> None:
        assert self.redis
        raw = await self.redis.hgetall(config.KEY_POOLS_LATEST)
        if not raw:
            log.info("no pools in redis yet (is the ingestor running?)")
            return
        now_ms = int(time.time() * 1000)
        pools = {address: json.loads(value) for address, value in raw.items()}
        security_raw = await self.redis.hgetall(config.KEY_SECURITY_LATEST)
        self.security = {mint: json.loads(value) for mint, value in security_raw.items()}
        insights_raw = await self.redis.hgetall(config.KEY_GMGN_LATEST)
        self.insights = {mint: json.loads(value) for mint, value in insights_raw.items()}
        depth_raw = await self.redis.hgetall(config.KEY_BINS_LATEST)
        depth: dict[str, Depth] = {}
        for address, value in depth_raw.items():
            try:
                depth[address] = Depth.parse(json.loads(value))
            except (KeyError, TypeError, ValueError):
                log.warning("bad bin depth for %s", address)
        self.depth = depth
        self.sol_usd = sol_usd_from_pools(pools.values()) or self.sol_usd
        await self._load_market(list(pools))

        for address, pool in pools.items():
            if now_ms - self.last_tick_ms.get(address, 0) > config.TICK_PRECEDENCE_MS:
                self.histories[address].add(pool["ts"], pool["price"], config.HISTORY_MS)
            elif (price := self.histories[address].last_price) is not None:
                pool["price"] = price
        for address in set(self.histories) - set(pools):
            del self.histories[address]
            self.last_tick_ms.pop(address, None)

        self.pools = pools
        self.rows = {address: self._build_row(pool, now_ms) for address, pool in pools.items()}
        self.updated_at = now_ms
        await self._save_metrics(now_ms)
        if self.papers:
            open_addresses: set[str] = set()
            async with self._paper_lock:
                for key, trader in self.papers.items():
                    try:
                        await trader.on_refresh(self.pools, self.rows, now_ms)
                    except Exception:
                        log.exception("paper trading update failed (%s)", key)
                    open_addresses.update(trader.open_addresses())
            try:
                # Tell the ingestor which pools must stay tracked while any profile holds positions in them.
                async with self.redis.pipeline(transaction=True) as pipe:
                    pipe.delete(config.KEY_PAPER_OPEN_POOLS)
                    if open_addresses:
                        pipe.sadd(config.KEY_PAPER_OPEN_POOLS, *sorted(open_addresses))
                    await pipe.execute()
            except Exception:
                log.exception("publishing open paper pools failed")
        self._broadcast(self.snapshot_message())

    async def reset_papers(self) -> dict[str, int]:
        """Start every risk profile again from its starting equity (positions and equity history deleted)."""
        async with self._paper_lock:
            return {key: await trader.reset() for key, trader in self.papers.items()}

    def _build_row(self, pool: dict[str, Any], now_ms: int) -> dict[str, Any]:
        address = pool["address"]
        history = self.histories[address]
        market = self.market.get(address)
        change_1h = history.change_pct(now_ms, HOUR_MS)
        if change_1h is None and market:
            change_1h = market.get("change_1h_pct")
        vol_1h = history.realized_vol_pct(now_ms, HOUR_MS)
        base_mint = base_token(pool)["mint"]
        security = self.security.get(base_mint)
        insights = self.insights.get(base_mint)
        depth = self.depth.get(address)
        if depth is not None and (not depth.fresh(now_ms) or depth.bin_step != pool["bin_step"]):
            depth = None
        y_usd = (pool.get("token_y") or {}).get("price_usd") or 0.0
        window = window_bins(pool["bin_step"], (market or {}).get("atr_pct") or vol_1h)
        pool_per_bin_y = depth_per_bin_y(depth, window) if depth is not None and y_usd > 0 else None
        pool_per_bin_usd = pool_per_bin_y * y_usd if pool_per_bin_y is not None else None
        scored = score_pool(
            pool, change_1h, vol_1h, now_ms, security, self.position_usd, market, insights,
            pool_per_bin_usd=pool_per_bin_usd, fee_bins=2 * window + 1,
        )
        plan = plan_position(
            bin_step=pool["bin_step"],
            tvl=pool["tvl"],
            score=scored["score"],
            safety=scored["safety"],
            flags=scored["flags"],
            change_pct_1h=change_1h,
            realized_vol_pct_1h=vol_1h,
            fee_for_position_pct_day=scored["fee_for_position_pct_day"],
            params=self.plan_params,
            market=market,
        )
        new_arrays = None
        if plan.get("action") == "enter":
            lower = -bins_below(-plan["range_low_pct"], pool["bin_step"])
            upper = bins_for_width(plan["range_high_pct"], pool["bin_step"])
            if pool_per_bin_usd is not None:
                # Re-estimate with the plan's own size and bin count: a wider range spreads thinner per bin.
                pct = fee_for_position_pct_day(
                    expected_fee_pct_day(pool["fee_tvl_pct"]), pool["tvl"] or 0.0, plan["size_usd"], plan["bins"],
                    pool_per_bin_usd, window, (pool["volume"].get("24h") or 0.0) / 24 or None,
                )
                scored["fee_for_position_pct_day"] = pct
                plan["expected_fee_usd_day"] = round(plan["size_usd"] * pct / 100, 2)
            if depth is not None:
                new_arrays = new_bin_arrays(depth, lower, upper)
                plan["new_bin_arrays"] = new_arrays
        plan_base = None  # entry plan before the cost gate: each risk profile applies its own gate
        if plan.get("action") == "enter" and self.paper and self.paper.cfg.costs.enabled and self.sol_usd:
            # Entry only when fees over the minimum hold pay back round-trip costs (same gate as the backtest).
            lp = LpPosition.build(
                pool["price"], pool["bin_step"], plan["range_low_pct"], plan["range_high_pct"], plan["size_usd"]
            )
            cost_pct = round_trip_cost_pct(
                lp, int(plan.get("positions") or 1), pool, 1.0, self.sol_usd, self.paper.cfg.costs, new_arrays
            )
            plan_base = dict(plan, round_trip_cost_pct=round(cost_pct, 3))
            plan = apply_cost_gate(plan, cost_pct, scored["fee_for_position_pct_day"], self.plan_params)
        tvl_per_bin_usd = None
        if depth is not None and y_usd > 0:
            tvl_per_bin_usd = sum(depth.bins.values()) * y_usd / max(1, len(depth.bins))
        row = {
            "address": address,
            "name": pool["name"],
            "bin_step": pool["bin_step"],
            "base_fee_pct": pool["base_fee_pct"],
            "dynamic_fee_pct": pool["dynamic_fee_pct"],
            "price": pool["price"],
            "tvl": pool["tvl"],
            "volume_24h": pool["volume"]["24h"],
            "fees_24h": pool["fees"]["24h"],
            "change_pct_1h": change_1h,
            "realized_vol_pct_1h": vol_1h,
            "watched": now_ms - self.last_tick_ms.get(address, 0) < 10 * 60 * 1000,
            "updated_at": now_ms,
            "plan": _clean(plan),
            "plan_base": _clean(plan_base),
            "security": _security_summary(security),
            "market": _clean(market),
            "insights": _clean(insights),
            "depth_per_bin_y": pool_per_bin_y,
            "depth": None if depth is None else {
                "age_sec": round((now_ms - depth.ts) / 1000),
                "window_bins": window,
                "per_bin_usd": pool_per_bin_usd,
                "active_bin_usd": depth.bins.get(0, 0.0) * y_usd if y_usd > 0 else None,
                "avg_nonempty_bin_usd": tvl_per_bin_usd,
                "new_bin_arrays": new_arrays,
            },
            **scored,
        }
        return {k: _clean(v) for k, v in row.items()}

    async def _save_metrics(self, now_ms: int) -> None:
        assert self.db
        if not self.rows:
            return
        ts = datetime.fromtimestamp(now_ms / 1000, tz=timezone.utc)
        await self.db.executemany(
            """
            insert into pool_metrics (ts, address, score, fee_tvl_pct_24h, fee_tvl_pct_1h_x24,
                                      volume_tvl_24h, change_pct_1h, realized_vol_pct_1h, flags,
                                      safety, fee_for_position_pct_day, recommendation, regime)
            values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13)
            """,
            [
                (
                    ts, r["address"], r["score"], r["fee_tvl_pct_24h"], r["fee_tvl_pct_1h_x24"],
                    r["volume_tvl_24h"], r["change_pct_1h"], r["realized_vol_pct_1h"], r["flags"],
                    r["safety"], r["fee_for_position_pct_day"], json.dumps(r["plan"]), r["regime"],
                )
                for r in self.rows.values()
            ],
        )

    # stream consumers

    async def _consume_pools(self) -> None:
        assert self.redis
        last_id = "$"
        while True:
            try:
                resp = await self.redis.xread({config.STREAM_POOLS: last_id}, block=5000, count=10)
                if not resp:
                    continue
                for _stream, messages in resp:
                    last_id = messages[-1][0]
                await self._refresh_pools()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("pool stream error")
                await asyncio.sleep(2)

    async def _consume_prices(self) -> None:
        assert self.redis
        last_id = "$"
        pending: set[str] = set()
        last_broadcast = time.monotonic()
        while True:
            try:
                resp = await self.redis.xread({config.STREAM_PRICES: last_id}, block=1000, count=500)
                for _stream, messages in resp or []:
                    for message_id, fields in messages:
                        last_id = message_id
                        address = fields["address"]
                        ts_ms = int(fields["ts"])
                        self.last_tick_ms[address] = ts_ms
                        self.histories[address].add(ts_ms, float(fields["price"]), config.HISTORY_MS)
                        if address in self.pools:
                            pending.add(address)

                if pending and time.monotonic() - last_broadcast >= TICK_BROADCAST_INTERVAL_SEC:
                    now_ms = int(time.time() * 1000)
                    updates = []
                    for address in pending:
                        pool = self.pools[address]
                        if (price := self.histories[address].last_price) is not None:
                            pool["price"] = price
                        self.rows[address] = self._build_row(pool, now_ms)
                        updates.append(self.rows[address])
                    self._broadcast({"type": "update", "pools": updates})
                    pending.clear()
                    last_broadcast = time.monotonic()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("price stream error")
                await asyncio.sleep(2)
