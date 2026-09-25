"""Holder bubble map for one token, from RugCheck (free): the top holders, and the transfer graph between wallets.

Wallets that sent the token to each other are joined into one cluster (union-find over the graph's links), so a
supply spread across many wallets by one person shows as one group. Pools, AMMs and lockers are marked and left out
of the holder totals: they hold for everyone.
"""

import json
import logging
import time
import urllib.request
from typing import Any

log = logging.getLogger("holders_map")

BASE = "https://api.rugcheck.xyz/v1/tokens"
TTL_S = 30 * 60
_cache: dict[str, tuple[float, dict[str, Any]]] = {}


def _get(url: str) -> Any:
    req = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "quant-engine/0.1"})
    with urllib.request.urlopen(req, timeout=20) as res:
        return json.load(res)


def build(report: dict[str, Any], graph: list[dict[str, Any]] | None) -> dict[str, Any]:
    token = report.get("token") or {}
    supply = float(token.get("supply") or 0)
    known = report.get("knownAccounts") or {}
    nodes: dict[str, dict[str, Any]] = {}

    def node(owner: str) -> dict[str, Any]:
        if owner not in nodes:
            k = known.get(owner) or {}
            kind = "pool" if k.get("type") in {"AMM", "LOCKER"} else "wallet"
            nodes[owner] = {"id": owner, "pct": 0.0, "insider": False, "kind": kind, "label": k.get("name")}
        return nodes[owner]

    for h in report.get("topHolders") or []:
        owner = h.get("owner") or h.get("address")
        if not owner:
            continue
        n = node(owner)
        n["pct"] = max(n["pct"], float(h.get("pct") or 0))
        n["insider"] = n["insider"] or bool(h.get("insider"))
        if known.get(h.get("address") or "", {}).get("type") in {"AMM", "LOCKER"}:
            n["kind"] = "pool"

    links: list[dict[str, str]] = []
    for net in graph or []:
        for gn in net.get("nodes") or []:
            n = node(gn["id"])
            if supply > 0 and gn.get("holdings"):
                n["pct"] = max(n["pct"], float(gn["holdings"]) / supply * 100)
            n["insider"] = True  # RugCheck's insider networks: wallets tied to each other by transfers
        for ln in net.get("links") or []:
            if ln.get("source") and ln.get("target") and ln["source"] != ln["target"]:
                node(ln["source"])
                node(ln["target"])
                links.append({"source": ln["source"], "target": ln["target"]})

    parent = {k: k for k in nodes}

    def find(x: str) -> str:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for ln in links:
        a, b = find(ln["source"]), find(ln["target"])
        if a != b:
            parent[a] = b
    groups: dict[str, list[str]] = {}
    for k in nodes:
        groups.setdefault(find(k), []).append(k)
    clusters = []
    for members in groups.values():
        if len(members) < 2:
            continue
        pct = sum(nodes[m]["pct"] for m in members if nodes[m]["kind"] == "wallet")
        clusters.append({"members": members, "pct": pct, "holding": sum(nodes[m]["pct"] > 0 for m in members)})
    clusters.sort(key=lambda c: -c["pct"])
    for i, c in enumerate(clusters):
        for m in c["members"]:
            nodes[m]["cluster"] = i
    wallets = sorted((n for n in nodes.values() if n["kind"] == "wallet"), key=lambda n: -n["pct"])
    return {
        "nodes": list(nodes.values()),
        "links": links,
        "clusters": [{"id": i, "size": len(c["members"]), "holding": c["holding"], "pct": c["pct"]} for i, c in enumerate(clusters)],
        "summary": {
            "top10_pct": sum(n["pct"] for n in wallets[:10]),
            "insider_pct": sum(n["pct"] for n in wallets if n["insider"]),
            "clustered_pct": sum(c["pct"] for c in clusters),
            "largest_cluster": {k: clusters[0][k] for k in ("pct", "holding")} | {"size": len(clusters[0]["members"])}
            if clusters else None,
            "total_holders": report.get("totalHolders"),
        },
    }


def holders_map(mint: str) -> dict[str, Any]:
    hit = _cache.get(mint)
    if hit and hit[0] > time.time():
        return hit[1]
    report = _get(f"{BASE}/{mint}/report")
    try:
        graph = _get(f"{BASE}/{mint}/insiders/graph")
    except Exception as err:  # the graph is optional: without it the map is holders only
        log.info("insider graph for %s: %s", mint[:6], err)
        graph = None
    out = {"mint": mint, "fetched_at": int(time.time() * 1000), **build(report, graph if isinstance(graph, list) else None)}
    if len(_cache) > 300:
        _cache.pop(min(_cache, key=lambda k: _cache[k][0]))
    _cache[mint] = (time.time() + TTL_S, out)
    return out
