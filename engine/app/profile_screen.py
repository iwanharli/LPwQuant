"""What an LP paper profile sees in the live pools: why pools fail it, and for the ones that pass the safety and
plan screen, the entry checklist item by item (volatility cap, fee gate). Same numbers the trader uses."""

import re
from typing import Any

from .charts import profile_decision


def _norm(reason: str) -> str:
    """Group reasons that differ only in their numbers or flag names."""
    if reason.startswith("Flag risiko berat"):
        return "Flag risiko berat"
    return re.sub(r"[-+]?\d+(?:[.,]\d+)?", "#", reason).replace("#x", "N×").replace("# jam", "N jam")


def screen(rows: dict[str, dict[str, Any]], trader) -> dict[str, Any]:
    cfg = trader.cfg
    funnel: dict[str, int] = {}
    pools = []
    for row in rows.values():
        d = profile_decision(row, trader)
        plan = row.get("plan_single") if cfg.plan_variant == "single" else (row.get("plan_base") or row.get("plan"))
        planned = bool(plan) and plan.get("action") == "enter"
        # "lolos" = passed the screen (safety and plan); the entry checklist below says what still holds it back.
        if d.get("holding") or d["enter"] or (planned and (plan or {}).get("tier") in cfg.tiers):
            key = "lolos"
        else:
            key = _norm(d.get("reason") or (plan or {}).get("reason") or "tidak ada rencana masuk")
        funnel[key] = funnel.get(key, 0) + 1
        if not planned or plan.get("tier") not in cfg.tiers:
            continue
        # Passed the safety and plan screen: the entry checklist.
        atr = (row.get("market") or {}).get("atr_pct")
        fee_day = plan.get("fee_for_position_pct_day") or row.get("fee_for_position_pct_day") or 0.0
        need = (plan.get("round_trip_cost_pct") or 0.0) * (cfg.min_fee_cost_ratio or 1.0)
        coverage = (fee_day * (cfg.fee_gate_hours or 1.0) / 24) / need if need > 0 else None
        checks = [
            {"key": "tier", "label": f"Tier {plan.get('tier')} dipakai profil ini", "ok": True, "detail": "lolos cek keamanan dan rencana"},
        ]
        if cfg.max_atr_pct is not None:
            checks.append({"key": "atr", "label": f"Volatilitas (ATR 30m) ≤ {cfg.max_atr_pct:g}%",
                           "ok": atr is not None and atr <= cfg.max_atr_pct,
                           "detail": "belum ada data" if atr is None else f"ATR {atr:.2f}%"})
        checks.append({"key": "fee", "label": f"Fee {cfg.fee_gate_hours:g} jam ≥ {cfg.min_fee_cost_ratio:g}× biaya bolak-balik",
                       "ok": coverage is not None and coverage >= 1,
                       "detail": "–" if coverage is None else f"baru {coverage:.2f}× dari yang dibutuhkan"})
        pools.append({
            "address": row["address"], "name": row.get("name"), "price": row.get("price"), "market_cap": row.get("market_cap"),
            "volume_24h": row.get("volume_24h"), "tvl": row.get("tvl"), "fee_tvl_pct_24h": row.get("fee_tvl_pct_24h"),
            "holders": row.get("holders"), "top10_pct": (row.get("security") or {}).get("top10_pct"),
            "change_pct_1h": row.get("change_pct_1h"), "checks": checks,
            "entry_ok": bool(d["enter"]), "held": bool(d.get("holding")), "coverage": coverage,
        })
    pools.sort(key=lambda p: (not p["held"], not p["entry_ok"], -(p["coverage"] or 0)))
    return {"funnel": dict(sorted(funnel.items(), key=lambda kv: -kv[1])), "pools": pools[:25]}
