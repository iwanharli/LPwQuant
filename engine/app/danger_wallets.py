"""Dangerous pool creators: wallets that created a DLMM pool and then drained it, or created a pool with several signs of
being a set-up rather than a market.

Every EVERY_S:
  * the newest pools from Meteora's API plus the screener's young pools are tracked for their first WATCH_HOURS: their
    creator (read on chain from the pool account, so it is known even after the pool is emptied) and peak TVL;
  * a tracked pool whose TVL falls under DRAIN_FRAC of a peak of at least MIN_PEAK_TVL is a "drained" event;
  * a screener row with 2+ danger signs is a "suspicious" event.
Each event is kept once per pool, with its evidence, and the creator appears on the list. Pools from a listed
creator get a danger sign of their own (service.danger_signs).

Network (trace_loop): every listed creator, and then the wallet that first funded it, is traced through the ingestor
(/wallet-trace): its funders and the wallets it sent SOL to or got SOL from. Busy counterparties (exchanges, bots)
are kept as evidence but never link two wallets. Creators that share a funder or a counterparty, or paid each other,
form one group; a non-busy wallet tied to a listed creator is "linked", and its own new pools get a danger sign too.
"""

import asyncio
import json
import logging
import time
import urllib.parse
from datetime import datetime, timezone
from typing import Any, Callable

from . import config, portfolio
from .lp_leaders import _get_json

log = logging.getLogger("danger_wallets")

EVERY_S = 300
WATCH_HOURS = 48
MIN_PEAK_TVL = 1000.0
DRAIN_FRAC = 0.1

# The creators on the list, kept in memory for the screener's danger signs (refreshed every round).
KNOWN: dict[str, int] = {}
CREATOR_OF: dict[str, str] = {}  # pool -> creator, for the pools being watched
LINKED: dict[str, str] = {}  # wallet tied by SOL to a listed creator -> how, for the screener's danger sign

TRACE_EVERY_S = 90
RETRACE_HOURS = 24


async def _creators(pools: list[str]) -> dict[str, str | None]:
    out: dict[str, str | None] = {}
    for i in range(0, len(pools), 100):
        chunk = pools[i:i + 100]
        url = f"{config.CLAIM_SERVER_URL}/pool-creators?{urllib.parse.urlencode({'pools': ','.join(chunk)})}"
        try:
            out.update((await asyncio.to_thread(_get_json, url, 60)).get("creators") or {})
        except Exception as err:
            log.info("pool creators: %s", err)
    return out


async def _event(db, creator: str, kind: str, pool: str, name: str, evidence: dict[str, Any]) -> None:
    await db.execute(
        """insert into danger_events (pool, creator, kind, name, evidence, seen_at) values ($1,$2,$3,$4,$5::jsonb, now())
           on conflict (pool, kind) do nothing""",
        pool, creator, kind, name, json.dumps(evidence),
    )


async def step(db, rows: dict[str, dict[str, Any]]) -> None:
    now = time.time()
    try:
        body = await asyncio.to_thread(
            portfolio._get, "/pools",
            {"page": 1, "page_size": 100, "sort_by": "pool_created_at:desc", "filter_by": "is_blacklisted=false"})
        newest = body.get("data") or []
    except Exception as err:
        log.info("newest pools: %s", err)
        newest = []
    seen: dict[str, dict[str, Any]] = {}
    for p in newest:
        age_h = (now * 1000 - (p.get("created_at") or 0)) / 3_600_000
        if age_h <= WATCH_HOURS:
            seen[p["address"]] = {"name": p.get("name") or "?", "tvl": float(p.get("tvl") or 0), "created_at": p.get("created_at")}
    for r in rows.values():
        if (r.get("pool_age_hours") or 1e9) <= WATCH_HOURS:
            seen.setdefault(r["address"], {"name": r.get("name") or "?", "tvl": float(r.get("tvl") or 0), "created_at": None})

    tracked = {r["pool"]: dict(r) for r in await db.fetch(
        "select * from danger_pool_watch where first_seen > now() - make_interval(hours => $1)", WATCH_HOURS)}
    new = [a for a in seen if a not in tracked]
    creators = await _creators(new) if new else {}
    for a in new:
        info = seen[a]
        await db.execute(
            """insert into danger_pool_watch (pool, name, creator, peak_tvl, last_tvl, first_seen)
               values ($1,$2,$3,$4,$4, now()) on conflict (pool) do nothing""",
            a, info["name"], creators.get(a), info["tvl"])
    # Tracked pools that fell out of both lists (an emptied pool leaves the screener): ask Meteora directly.
    for a, t in tracked.items():
        if a in seen:
            continue
        try:
            p = await asyncio.to_thread(portfolio._get, f"/pools/{a}", {})
            seen[a] = {"name": t["name"], "tvl": float(p.get("tvl") or 0), "created_at": p.get("created_at")}
        except Exception:
            continue
        await asyncio.sleep(0.1)

    for a, info in seen.items():
        t = tracked.get(a)
        if t is None:
            continue
        peak = max(t["peak_tvl"] or 0.0, info["tvl"])
        await db.execute("update danger_pool_watch set peak_tvl = $2, last_tvl = $3 where pool = $1", a, peak, info["tvl"])
        creator = t["creator"]
        if not creator:
            continue
        if peak >= MIN_PEAK_TVL and info["tvl"] < peak * DRAIN_FRAC:
            await _event(db, creator, "drained", a, t["name"], {
                "peak_tvl": peak, "tvl_after": info["tvl"],
                "hours_after_seen": (now - t["first_seen"].timestamp()) / 3600})

    for r in rows.values():
        if len(r.get("danger") or []) >= 2:
            c = (await db.fetchval("select creator from danger_pool_watch where pool = $1", r["address"]))
            if c:
                await _event(db, c, "suspicious", r["address"], r.get("name") or "?", {"signs": r["danger"], "tvl": r.get("tvl")})

    CREATOR_OF.clear()
    for row in await db.fetch("select pool, creator from danger_pool_watch where creator is not null"):
        CREATOR_OF[row["pool"]] = row["creator"]
    KNOWN.clear()
    for row in await db.fetch("select creator, count(*) as n from danger_events group by creator"):
        KNOWN[row["creator"]] = row["n"]
    if not LINKED:
        await _refresh_linked(db)


async def loop(db, rows: Callable[[], dict[str, dict[str, Any]]]) -> None:
    await asyncio.sleep(60)
    while True:
        try:
            await step(db, rows())
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("danger wallets round failed")
        await asyncio.sleep(EVERY_S)


async def trace(wallet: str) -> dict[str, Any]:
    url = f"{config.CLAIM_SERVER_URL}/wallet-trace?{urllib.parse.urlencode({'wallet': wallet})}"
    return await asyncio.to_thread(_get_json, url, 900)


async def _save_trace(db, wallet: str, role: str) -> dict[str, Any] | None:
    try:
        data = await trace(wallet)
        await db.execute(
            """insert into danger_traces (wallet, role, data, error, traced_at) values ($1,$2,$3::jsonb,null,now())
               on conflict (wallet) do update set data = excluded.data, error = null, traced_at = now(),
               role = case when danger_traces.role = 'creator' then 'creator' else excluded.role end""",
            wallet, role, json.dumps(data))
        return data
    except Exception as err:
        log.info("trace %s: %s", wallet[:6], err)
        await db.execute(
            """insert into danger_traces (wallet, role, error, traced_at) values ($1,$2,$3,now())
               on conflict (wallet) do update set error = excluded.error, traced_at = now()""",
            wallet, role, str(err)[:300])
        return None


def _jl(v: Any) -> Any:
    return json.loads(v) if isinstance(v, str) else v


async def _next_to_trace(db) -> tuple[str, str] | None:
    """Creators never traced (or stale) first, then the first funder of each traced creator (one hop back)."""
    row = await db.fetchrow(
        """select e.creator from (select creator, max(seen_at) as last from danger_events group by creator) e
           left join danger_traces t on t.wallet = e.creator
           where t.wallet is null or t.traced_at < now() - make_interval(hours => $1)
           order by t.traced_at nulls first, e.last desc limit 1""", RETRACE_HOURS)
    if row:
        return row["creator"], "creator"
    traced = {r["wallet"] for r in await db.fetch("select wallet from danger_traces")}
    for r in await db.fetch("select data from danger_traces where role = 'creator' and data is not null"):
        for f in (_jl(r["data"]).get("funders") or [])[:1]:
            if not f.get("busy") and f["wallet"] not in traced:
                return f["wallet"], "funder"
    return None


async def trace_loop(db) -> None:
    await asyncio.sleep(120)
    while True:
        try:
            nxt = await _next_to_trace(db)
            if nxt:
                await _save_trace(db, *nxt)
                await _refresh_linked(db)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("danger trace round failed")
        await asyncio.sleep(TRACE_EVERY_S)


def _network(creators: set[str], traces: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """Nodes, links and groups from the stored traces."""
    links: dict[tuple[str, str, str], dict[str, Any]] = {}
    busy: set[str] = set()

    def edge(a: str, b: str, kind: str, sol: float, at: int | None) -> None:
        k = (a, b, kind)
        e = links.setdefault(k, {"source": a, "target": b, "kind": kind, "sol": 0.0, "at": at})
        e["sol"] += sol
        if at and (e["at"] is None or at < e["at"]):
            e["at"] = at

    for w, t in traces.items():
        for f in t.get("funders") or []:
            (busy.add(f["wallet"]) if f.get("busy") else None)
            edge(f["wallet"], w, "fund", f["sol"], f.get("at"))
        for f in t.get("sent_to") or []:
            (busy.add(f["wallet"]) if f.get("busy") else None)
            edge(w, f["wallet"], "send", f["sol"], f.get("first_at"))
        for f in t.get("received_from") or []:
            (busy.add(f["wallet"]) if f.get("busy") else None)
            edge(f["wallet"], w, "send", f["sol"], f.get("first_at"))

    # Groups: union-find over every non-busy wallet, then kept only where 2+ listed creators meet.
    parent: dict[str, str] = {}

    def find(x: str) -> str:
        parent.setdefault(x, x)
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for e in links.values():
        if e["source"] in busy or e["target"] in busy:
            continue
        parent[find(e["source"])] = find(e["target"])
    members: dict[str, list[str]] = {}
    for c in creators:
        members.setdefault(find(c), []).append(c)
    groups = [sorted(m) for m in members.values() if len(m) >= 2]
    groups.sort(key=len, reverse=True)
    group_of = {c: i + 1 for i, g in enumerate(groups) for c in g}

    degree: dict[str, set[str]] = {}
    for e in links.values():
        for a, b in ((e["source"], e["target"]), (e["target"], e["source"])):
            if a in creators and b not in busy:
                degree.setdefault(b, set()).add(a)
    linked = []
    for w, cs in degree.items():
        if w in creators:
            continue
        roles = set()
        for e in links.values():
            if e["source"] == w and e["target"] in cs:
                roles.add("pendana" if e["kind"] == "fund" else "mengirim ke pembuat")
            if e["target"] == w and e["source"] in cs:
                roles.add("menerima dari pembuat")
        linked.append({"wallet": w, "creators": sorted(cs), "roles": sorted(roles),
                       "traced": w in traces, "group": next((group_of[c] for c in cs if c in group_of), None)})
    linked.sort(key=lambda x: (-len(x["creators"]), x["wallet"]))

    # Graph: listed creators, every non-busy wallet next to one, and busy ones only as single labelled nodes.
    keep = set(creators) | {l["wallet"] for l in linked} | busy
    nodes = []
    for w in keep:
        kind = "creator" if w in creators else "busy" if w in busy else "linked"
        nodes.append({"id": w, "kind": kind, "group": group_of.get(w) or next(
            (l["group"] for l in linked if l["wallet"] == w), None)})
    graph_links = [e for e in links.values() if e["source"] in keep and e["target"] in keep
                   and (e["source"] in creators or e["target"] in creators or e["source"] in traces or e["target"] in traces)]
    used = {x for e in graph_links for x in (e["source"], e["target"])} | set(creators)
    nodes = [n for n in nodes if n["id"] in used]
    return {"nodes": nodes, "links": graph_links, "groups": [{"id": i + 1, "wallets": g} for i, g in enumerate(groups)],
            "linked": linked, "group_of": group_of, "busy": sorted(busy)}


async def _load(db) -> tuple[set[str], dict[str, dict[str, Any]], dict[str, dict[str, Any]]]:
    creators = {r["creator"] for r in await db.fetch("select distinct creator from danger_events")}
    rows = {r["wallet"]: dict(r) for r in await db.fetch("select * from danger_traces")}
    traces = {w: _jl(r["data"]) for w, r in rows.items() if r["data"] is not None}
    return creators, traces, rows


async def _refresh_linked(db) -> None:
    creators, traces, _ = await _load(db)
    net = _network(creators, traces)
    LINKED.clear()
    for l in net["linked"]:
        LINKED[l["wallet"]] = ", ".join(l["roles"]) or "berbagi aliran dana"


async def wallet_detail(db, wallet: str) -> dict[str, Any]:
    """One wallet: its events, its full trace, its group and the linked wallets around it."""
    creators, traces, rows = await _load(db)
    net = _network(creators, traces)
    events = [dict(r) | {"evidence": _jl(r["evidence"]), "at": int(r["seen_at"].timestamp() * 1000)}
              for r in await db.fetch("select pool, name, kind, evidence, seen_at from danger_events where creator = $1 order by seen_at desc", wallet)]
    for e in events:
        e.pop("seen_at", None)
    pools = [dict(r) | {"first_seen": int(r["first_seen"].timestamp() * 1000)} for r in await db.fetch(
        "select pool, name, peak_tvl, last_tvl, first_seen from danger_pool_watch where creator = $1 order by first_seen desc limit 50", wallet)]
    row = rows.get(wallet)
    gid = net["group_of"].get(wallet)
    return {
        "wallet": wallet,
        "tracing": wallet in TRACING,
        "listed": wallet in creators,
        "events": events,
        "pools": pools,
        "trace": traces.get(wallet),
        "trace_error": row["error"] if row else None,
        "traced_at": int(row["traced_at"].timestamp() * 1000) if row else None,
        "group": gid,
        "group_wallets": next((g["wallets"] for g in net["groups"] if g["id"] == gid), []),
        "linked": [l for l in net["linked"] if wallet in l["creators"]],
        "linked_to": next((l for l in net["linked"] if l["wallet"] == wallet), None),
        "busy": net["busy"],
    }


TRACING: set[str] = set()


async def trace_now(db, wallet: str) -> dict[str, Any]:
    """Start a trace in the background (it takes minutes, longer than a proxied request may wait)."""
    if wallet not in TRACING:
        TRACING.add(wallet)
        role = "creator" if await db.fetchval("select 1 from danger_events where creator = $1 limit 1", wallet) else "manual"

        async def run() -> None:
            try:
                await _save_trace(db, wallet, role)
                await _refresh_linked(db)
            finally:
                TRACING.discard(wallet)

        asyncio.create_task(run(), name=f"trace {wallet[:6]}")
    return await wallet_detail(db, wallet)


async def report(db) -> dict[str, Any]:
    events = [dict(r) for r in await db.fetch("select * from danger_events order by seen_at desc limit 1000")]
    by: dict[str, dict[str, Any]] = {}
    for e in events:
        w = by.setdefault(e["creator"], {"wallet": e["creator"], "drained": 0, "suspicious": 0, "drained_usd": 0.0,
                                         "last_at": None, "events": []})
        ev = json.loads(e["evidence"]) if isinstance(e["evidence"], str) else dict(e["evidence"])
        w[e["kind"]] += 1
        if e["kind"] == "drained":
            w["drained_usd"] += max(0.0, (ev.get("peak_tvl") or 0) - (ev.get("tvl_after") or 0))
        at = int(e["seen_at"].timestamp() * 1000)
        w["last_at"] = max(w["last_at"] or 0, at)
        w["events"].append({"pool": e["pool"], "name": e["name"], "kind": e["kind"], "at": at, "evidence": ev})
    creators, traces, rows = await _load(db)
    net = _network(creators, traces)
    for w in by.values():
        t = traces.get(w["wallet"])
        row = rows.get(w["wallet"])
        w["group"] = net["group_of"].get(w["wallet"])
        w["linked"] = sum(1 for l in net["linked"] if w["wallet"] in l["creators"])
        w["traced_at"] = int(row["traced_at"].timestamp() * 1000) if row else None
        w["trace"] = None if not t else {
            "tx_count": t.get("tx_count"), "tx_count_capped": t.get("tx_count_capped"), "first_at": t.get("first_at"),
            "sol_balance": t.get("sol_balance"),
            "funder": (t.get("funders") or [None])[0],
            "sent_sol": sum(f["sol"] for f in t.get("sent_to") or []),
        }
    wallets = sorted(by.values(), key=lambda w: (-(w["drained"] + w["suspicious"]), -(w["last_at"] or 0)))
    watched = await db.fetchval("select count(*) from danger_pool_watch where first_seen > now() - make_interval(hours => $1)", WATCH_HOURS)
    net.pop("group_of")
    return {"wallets": wallets, "watched_pools": watched, "network": net,
            "traced": sum(1 for w in creators if w in traces), "pending_trace": sum(1 for w in creators if w not in rows),
            "rules": {"watch_hours": WATCH_HOURS, "min_peak_tvl": MIN_PEAK_TVL, "drain_pct": DRAIN_FRAC * 100}}
