"""Telegram alerts for new DLMM pools and pools that clear the entry gate.

Inert without credentials: no bot token or chat id means no outbound request is ever made, so this can ship
switched off. Sending uses urllib from the standard library (the engine has no HTTP client dependency) wrapped in
asyncio.to_thread, because a blocking urlopen on the event loop would stall the whole refresh cycle.

Each pool fires once per kind, not once per 60-second cycle: what has been sent lives in the alerts_sent table,
so a restart does not replay it. The first cycle for a kind seeds that table without sending -- otherwise
switching alerts on would post the entire screener in one burst.
"""

import asyncio
import json
import logging
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from . import config

log = logging.getLogger("alerts")

API_URL = "https://api.telegram.org/bot{token}/sendMessage"
MAX_PER_CYCLE = 5  # a quiet trickle beats a flood when many pools qualify at once
KINDS = ("new_pool", "gate", "new_lp")

# Mirrors the screener's LP defaults (dashboard/app/lib/filters.ts defaultFilters).
LP_MAX_ATR_PCT = 5.0
LP_MAX_TOP10_PCT = 30.0
LP_MIN_TVL_USD = 25_000.0
NEW_POOL_MAX_AGE_HOURS = 24.0


def _num(value: Any) -> float | None:
    return float(value) if isinstance(value, (int, float)) else None


def top10_pct(row: dict[str, Any]) -> float | None:
    security = row.get("security") or {}
    organic = row.get("organic") or {}
    return _num(security.get("top10_pct")) if security.get("top10_pct") is not None else _num(organic.get("top_holders_pct"))


def atr_pct(row: dict[str, Any]) -> float | None:
    return _num((row.get("market") or {}).get("atr_pct"))


def is_new_pool(row: dict[str, Any]) -> bool:
    age = _num(row.get("pool_age_hours"))
    return age is not None and age <= NEW_POOL_MAX_AGE_HOURS


def passes_lp_filters(row: dict[str, Any]) -> bool:
    atr, top10, tvl = atr_pct(row), top10_pct(row), _num(row.get("tvl"))
    if atr is None or atr > LP_MAX_ATR_PCT:
        return False
    if top10 is None or top10 > LP_MAX_TOP10_PCT:
        return False
    return tvl is not None and tvl >= LP_MIN_TVL_USD


def passes_gate(row: dict[str, Any]) -> bool:
    """Fees expected over the gate window cover min_fee_cost_ratio times the round trip, the same test the
    profiles apply to plan_base."""
    plan = row.get("plan_base") or {}
    if plan.get("action") != "enter":
        return False
    cost = _num(plan.get("round_trip_cost_pct"))
    fee_day = _num(row.get("fee_for_position_pct_day"))
    if not cost or cost <= 0 or fee_day is None:
        return False
    return fee_day / 24 * config.FEE_GATE_HOURS >= config.MIN_FEE_COST_RATIO * cost


def matches(row: dict[str, Any], kind: str) -> bool:
    if kind == "new_pool":
        return is_new_pool(row)
    if kind == "new_lp":
        return is_new_pool(row) and passes_lp_filters(row)
    if kind == "gate":
        return passes_gate(row)
    raise ValueError(f"unknown alert kind: {kind}")


def _usd(value: float | None) -> str:
    if value is None:
        return "–"
    for unit, size in (("M", 1e6), ("K", 1e3)):
        if abs(value) >= size:
            return f"${value / size:.2f}{unit}"
    return f"${value:,.2f}"


def _pct(value: float | None, digits: int = 1) -> str:
    return "–" if value is None else f"{value:.{digits}f}%"


def _esc(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


TITLES = {
    "new_pool": "Pool DLMM baru",
    "new_lp": "Pool baru lolos filter LP",
    "gate": "Kandidat lolos gate",
}


def message(row: dict[str, Any], kind: str) -> str:
    """Telegram HTML. Only fields this engine actually collects, so nothing here is a placeholder."""
    security = row.get("security") or {}
    organic = row.get("organic") or {}
    tags = ((row.get("insights") or {}).get("tags")) or {}
    plan = row.get("plan_base") or {}
    age = _num(row.get("pool_age_hours"))
    lines = [
        f"<b>{_esc(TITLES.get(kind, kind))}</b> · {_esc(str(row.get('name') or '?'))}",
        f"<code>{_esc(str(row.get('address') or ''))}</code>",
        "",
        f"MC {_usd(_num(row.get('market_cap')))} · TVL {_usd(_num(row.get('tvl')))} · "
        f"Vol24j {_usd(_num(row.get('volume_24h')))}",
        f"Holders {row.get('holders', '–')} · Top10 {_pct(top10_pct(row))} · "
        f"Umur {'–' if age is None else f'{age:.1f}j'}",
        f"ATR30m {_pct(atr_pct(row), 2)} · Fee/TVL24j {_pct(_num(row.get('fee_tvl_pct_24h')), 2)} · "
        f"Skor {row.get('score', '–')}",
    ]
    org_score = _num(organic.get("organic_score"))
    lines.append(
        f"Organic {'–' if org_score is None else f'{org_score:.0f}'} ({organic.get('organic_label') or '–'})"
        f" · Verified {'ya' if organic.get('verified') else 'tidak'}"
    )
    lines.append(
        f"Mint {'AKTIF' if security.get('mint_authority') else 'mati'} · "
        f"Freeze {'AKTIF' if security.get('freeze_authority') else 'mati'} · "
        f"LP locked {_pct(_num(security.get('lp_locked_pct')), 0)}"
    )
    bundler, sniper = tags.get("bundler") or {}, tags.get("sniper") or {}
    lines.append(
        f"Bundled {_pct(_num(bundler.get('holding_pct')))} · Snipers {_pct(_num(sniper.get('holding_pct')))} · "
        f"Bot holders {_pct(_num(organic.get('bot_holders_pct')))}"
    )
    risks = [r for r in (security.get("risks") or []) if isinstance(r, str)][:4]
    if risks:
        lines.append("Risiko: " + _esc(", ".join(risks)))
    flags = [f for f in (row.get("flags") or [])][:6]
    if flags:
        lines.append("Flag: " + _esc(", ".join(flags)))
    if kind == "gate" and plan:
        lines.append(
            f"Rencana: {plan.get('strategy')} {plan.get('range_low_pct')}%..{plan.get('range_high_pct')}% · "
            f"biaya {_pct(_num(plan.get('round_trip_cost_pct')), 2)} · "
            f"fee {_pct(_num(row.get('fee_for_position_pct_day')), 2)}/hari"
        )
    lines.append(f"https://meteora.ag/dlmm/{row.get('address')}")
    return "\n".join(lines)


def _post(token: str, chat_id: str, text: str) -> bool:
    payload = urllib.parse.urlencode(
        {"chat_id": chat_id, "text": text, "parse_mode": "HTML", "disable_web_page_preview": "true"}
    ).encode()
    request = urllib.request.Request(API_URL.format(token=token), data=payload)
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            return bool(json.load(response).get("ok"))
    except (urllib.error.URLError, TimeoutError, ValueError) as err:
        log.warning("telegram send failed: %s", err)
        return False


class Alerter:
    """Decides what to send, remembers what it sent, and never sends without credentials."""

    def __init__(self, db) -> None:
        self.db = db
        self.token = config.TELEGRAM_BOT_TOKEN
        self.chat_id = config.TELEGRAM_CHAT_ID
        self.kinds = tuple(k for k in config.ALERT_KINDS if k in KINDS)
        self.enabled = bool(config.ALERTS_ENABLED and self.token and self.chat_id and self.kinds)

    async def _already_sent(self, kind: str) -> set[str]:
        rows = await self.db.fetch("select address from alerts_sent where kind = $1", kind)
        return {r["address"] for r in rows}

    async def _remember(self, kind: str, addresses: list[str]) -> None:
        if addresses:
            await self.db.executemany(
                "insert into alerts_sent (kind, address, ts) values ($1, $2, now()) on conflict do nothing",
                [(kind, a) for a in addresses],
            )

    async def on_refresh(self, rows: dict[str, dict[str, Any]]) -> None:
        if not self.enabled or self.db is None:
            return
        for kind in self.kinds:
            try:
                await self._run_kind(kind, rows)
            except Exception:
                log.exception("alert kind %s failed", kind)

    async def _run_kind(self, kind: str, rows: dict[str, dict[str, Any]]) -> None:
        hits = [a for a, row in rows.items() if matches(row, kind)]
        if not hits:
            return
        sent = await self._already_sent(kind)
        fresh = [a for a in hits if a not in sent]
        if not fresh:
            return
        if not sent:
            # First run for this kind: record the current state instead of announcing all of it at once.
            await self._remember(kind, fresh)
            log.info("alerts: seeded %d pools for %s without sending", len(fresh), kind)
            return
        delivered: list[str] = []
        for address in fresh[:MAX_PER_CYCLE]:
            if await asyncio.to_thread(_post, self.token, self.chat_id, message(rows[address], kind)):
                delivered.append(address)
        await self._remember(kind, delivered)
        if delivered:
            log.info("alerts: sent %d %s", len(delivered), kind)
