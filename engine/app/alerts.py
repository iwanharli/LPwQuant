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

from . import config, flag_info
from .scoring import RISKY_FLAGS

log = logging.getLogger("alerts")

API_URL = "https://api.telegram.org/bot{token}/sendMessage"
MAX_PER_CYCLE = 5  # a quiet trickle beats a flood when many pools qualify at once
# Marks a kind as having run at least once. Without it, a kind that matched nothing on the first cycle looks
# indistinguishable from a kind that never ran, and its first real hit would be swallowed as "seeding" --
# which is exactly what would have happened to the first "gate" alert, the rarest and most wanted one.
SEED_MARKER = "__seeded__"
KINDS = ("new_pool", "gate", "new_lp", "stale")
POOL_KINDS = ("new_pool", "gate", "new_lp")
FRESHNESS_EVERY_MS = 5 * 60_000  # the check runs ~10 queries; data does not go stale faster than this

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


# A new pool is only announced once its safety data is in and clean: the fastest detection is also where rugs live
# (ALLINU was a day old, 99.6% held by ten wallets, its dev on token number 181).
NEW_POOL_MIN_TVL_USD = 5_000.0
NEW_POOL_MAX_TOP10_PCT = 50.0
NEW_POOL_BLOCKING_FLAGS = {"serial_dev", "bundler_heavy", "top_holders_50", "security_pending", "tvl_suspect"}


def safe_new_pool(row: dict[str, Any]) -> tuple[bool, str]:
    """(passes, reason it does not). Pending security data is a "not yet", not a "no": the pool is checked again on
    every refresh and announced the first time it passes."""
    if not is_new_pool(row):
        return False, "bukan pool baru"
    if not row.get("security"):
        return False, "cek RugCheck belum selesai"
    flags = set(row.get("flags") or [])
    bad = (flags & RISKY_FLAGS) | (flags & NEW_POOL_BLOCKING_FLAGS)
    if bad:
        return False, "flag " + ", ".join(sorted(bad))
    top10 = top10_pct(row)
    if top10 is None or top10 > NEW_POOL_MAX_TOP10_PCT:
        return False, "sebaran holder belum diketahui atau terlalu terpusat"
    tvl = _num(row.get("tvl"))
    if tvl is None or tvl < NEW_POOL_MIN_TVL_USD:
        return False, "TVL terlalu kecil"
    return True, ""


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
        return safe_new_pool(row)[0]
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
    "new_pool": "🆕 Pool DLMM baru",
    "new_lp": "🌱 Pool baru lolos filter LP",
    "gate": "🎯 Kandidat lolos gate",
}

WHY = {
    "new_pool": "Pool ini baru dibuat {age} dan sudah lolos cek keamanan dasar: RugCheck bersih, holder tidak terlalu "
    "terpusat, bukan dev serial, dan ada likuiditas. Tetap pool baru: data harganya masih sedikit.",
    "new_lp": "Pool baru ({age}) yang sudah lolos filter LP bawaan: harga cukup tenang, holder tidak terlalu "
    "terkonsentrasi, dan TVL cukup dalam.",
    "gate": "Perkiraan fee dalam {gate_h} jam sudah menutup {ratio}× biaya masuk-keluar, jadi rencana posisinya "
    "layak dipertimbangkan.",
}


def _ok(bad: bool) -> str:
    return "⚠️" if bad else "✅"


def _age_text(age: float | None) -> str:
    if age is None:
        return "umurnya tidak diketahui"
    if age < 1:
        return f"{age * 60:.0f} menit lalu"
    if age < 48:
        return f"{age:.1f} jam lalu"
    return f"{age / 24:.0f} hari lalu"


def concerns(row: dict[str, Any]) -> list[str]:
    """Plain-language warnings from the same fields the message shows, worst first."""
    security = row.get("security") or {}
    organic = row.get("organic") or {}
    tags = ((row.get("insights") or {}).get("tags")) or {}
    out: list[str] = []
    if security.get("mint_authority"):
        out.append("mint authority masih aktif (supply bisa ditambah)")
    if security.get("freeze_authority"):
        out.append("freeze authority aktif (token bisa dibekukan)")
    top10 = top10_pct(row)
    if top10 is not None and top10 > LP_MAX_TOP10_PCT:
        out.append(f"10 holder teratas memegang {top10:.0f}%")
    bundled = _num((tags.get("bundler") or {}).get("holding_pct"))
    if bundled is not None and bundled >= 20:
        out.append(f"{bundled:.0f}% supply dibeli lewat bundle")
    atr = atr_pct(row)
    if atr is not None and atr > LP_MAX_ATR_PCT:
        out.append(f"harga bergejolak (ATR {atr:.1f}% per 30 menit), rawan IL")
    tvl = _num(row.get("tvl"))
    if tvl is not None and tvl < LP_MIN_TVL_USD:
        out.append(f"TVL tipis ({_usd(tvl)})")
    return out


def message(row: dict[str, Any], kind: str) -> str:
    """Telegram HTML. Only fields this engine actually collects, so nothing here is a placeholder."""
    security = row.get("security") or {}
    organic = row.get("organic") or {}
    tags = ((row.get("insights") or {}).get("tags")) or {}
    plan = row.get("plan_base") or {}
    age = _num(row.get("pool_age_hours"))
    why = WHY.get(kind, "").format(
        age=_age_text(age), gate_h=f"{config.FEE_GATE_HOURS:g}", ratio=f"{config.MIN_FEE_COST_RATIO:g}"
    )
    warn = concerns(row)
    verdict = (
        "⚠️ <b>Perhatikan:</b> " + _esc("; ".join(warn)) + "."
        if warn
        else "✅ Tidak ada tanda bahaya dari data yang dicek."
    )
    lines = [
        f"<b>{_esc(TITLES.get(kind, kind))}</b>",
        f"<b>{_esc(str(row.get('name') or '?'))}</b>",
        "",
        _esc(why),
        verdict,
        "",
        "📊 <b>Pasar</b>",
        f"MC {_usd(_num(row.get('market_cap')))} · TVL {_usd(_num(row.get('tvl')))} · "
        f"Vol24j {_usd(_num(row.get('volume_24h')))}",
        f"Fee/TVL24j {_pct(_num(row.get('fee_tvl_pct_24h')), 2)} · ATR30m {_pct(atr_pct(row), 2)} · "
        f"Skor {row.get('score', '–')}",
        "",
        "🛡 <b>Keamanan</b>",
        f"{_ok(bool(security.get('mint_authority')))} Mint {'AKTIF' if security.get('mint_authority') else 'mati'} · "
        f"{_ok(bool(security.get('freeze_authority')))} Freeze {'AKTIF' if security.get('freeze_authority') else 'mati'} · "
        f"LP locked {_pct(_num(security.get('lp_locked_pct')), 0)}",
    ]
    risks = [r for r in (security.get("risks") or []) if isinstance(r, str)][:4]
    if risks:
        lines.append("RugCheck: " + _esc(", ".join(risks)))
    org_score = _num(organic.get("organic_score"))
    bundler, sniper = tags.get("bundler") or {}, tags.get("sniper") or {}
    lines += [
        "",
        "👥 <b>Holder</b>",
        f"Holders {row.get('holders', '–')} · Top10 {_pct(top10_pct(row))} · "
        f"Organic {'–' if org_score is None else f'{org_score:.0f}'} ({organic.get('organic_label') or '–'})"
        f" · Verified {'ya' if organic.get('verified') else 'tidak'}",
        f"Bundled {_pct(_num(bundler.get('holding_pct')))} · Snipers {_pct(_num(sniper.get('holding_pct')))} · "
        f"Bot holders {_pct(_num(organic.get('bot_holders_pct')))}",
    ]
    if kind == "gate" and plan:
        lines += [
            "",
            "📐 <b>Rencana posisi</b>",
            f"{plan.get('strategy')} {plan.get('range_low_pct')}%..{plan.get('range_high_pct')}% · "
            f"biaya {_pct(_num(plan.get('round_trip_cost_pct')), 2)} · "
            f"fee {_pct(_num(row.get('fee_for_position_pct_day')), 2)}/hari",
        ]
    flags = flag_info.sort_flags([f for f in (row.get("flags") or []) if isinstance(f, str)])
    if flags:
        shown = " · ".join(flag_info.chip(f) for f in flags[:8])
        more = f" · +{len(flags) - 8}" if len(flags) > 8 else ""
        lines += ["", "🏷 <b>Flag</b>", _esc(shown + more)]
    lines += ["", f"<code>{_esc(str(row.get('address') or ''))}</code>"]
    return "\n".join(lines)


def buttons(address: str, flags: list[str] | None = None) -> dict[str, Any]:
    """Link buttons under a pool alert (tapping beats copying an address on a phone), plus an Info flag button
    that the bot answers with the explanation of this pool's flags."""
    rows: list[list[dict[str, str]]] = [
        [
            {"text": "🌊 Meteora", "url": f"https://app.meteora.ag/dlmm/{address}"},
            {"text": "📈 DexScreener", "url": f"https://dexscreener.com/solana/{address}"},
        ]
    ]
    data = flag_info.encode(flags or [])
    if data != "fi:":
        rows.append([{"text": "ℹ️ Info flag", "callback_data": data}])
    return {"inline_keyboard": rows}


def _post(token: str, chat_id: str, text: str, markup: dict[str, Any] | None = None) -> bool:
    fields = {"chat_id": chat_id, "text": text, "parse_mode": "HTML", "disable_web_page_preview": "true"}
    if markup:
        fields["reply_markup"] = json.dumps(markup)
    payload = urllib.parse.urlencode(fields).encode()
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
        self._stale: set[str] | None = None  # labels stale at the last check; None until the first check
        self._fresh_checked_ms = 0

    async def _already_sent(self, kind: str) -> set[str]:
        rows = await self.db.fetch("select address from alerts_sent where kind = $1", kind)
        return {r["address"] for r in rows if r["address"] != SEED_MARKER}

    async def _seeded(self, kind: str) -> bool:
        """Any row at all means this kind has run before. Kinds recorded before the marker existed count too, so
        the change does not re-seed them and swallow a pool that appeared in the meantime."""
        return bool(await self.db.fetchval("select 1 from alerts_sent where kind = $1 limit 1", kind))

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
            if kind not in POOL_KINDS:
                continue
            try:
                await self._run_kind(kind, rows)
            except Exception:
                log.exception("alert kind %s failed", kind)

    async def check_freshness(self, now_ms: int) -> None:
        """Tell the chat when a data source goes stale and when it recovers, so a dead ingestor is noticed the same
        hour instead of the next time someone opens the dashboard. Only transitions are sent. The state lives in
        memory: a restart while something is stale re-announces it once, which is the right side to err on."""
        if not self.enabled or "stale" not in self.kinds or self.db is None:
            return
        if now_ms - self._fresh_checked_ms < FRESHNESS_EVERY_MS:
            return
        self._fresh_checked_ms = now_ms
        from .freshness import check_freshness  # local: freshness imports the db layer, alerts should stay light

        report = await check_freshness(self.db, now_ms)
        stale = set(report.get("stale") or [])
        previous, self._stale = self._stale, stale
        went_stale = stale - (previous or set())
        recovered = (previous or set()) - stale
        ages = {i["label"]: i.get("age_sec") for i in report.get("items") or []}
        if went_stale:
            lines = [
                "🔴 <b>Data basi</b>",
                "Sumber berikut berhenti mengirim data. Skor dan rencana posisi untuk pool terkait tidak bisa "
                "dipercaya sampai pulih; cek apakah ingestor masih berjalan.",
                "",
            ] + [
                f"• {_esc(l)} — terakhir {'belum ada' if ages.get(l) is None else f'{ages[l] / 60:.0f} mnt lalu'}"
                for l in sorted(went_stale)
            ]
            await asyncio.to_thread(_post, self.token, self.chat_id, "\n".join(lines))
        if recovered:
            await asyncio.to_thread(
                _post, self.token, self.chat_id, "🟢 <b>Data pulih</b>\nSumber berikut kembali mengirim data:\n\n" + "\n".join(f"• {_esc(l)}" for l in sorted(recovered))
            )

    async def _run_kind(self, kind: str, rows: dict[str, dict[str, Any]]) -> None:
        hits = [a for a, row in rows.items() if matches(row, kind)]
        if not await self._seeded(kind):
            # First run for this kind: record what already qualifies instead of announcing all of it at once, and
            # mark the kind as run even when nothing qualifies, so the next match is a real alert.
            await self._remember(kind, [*hits, SEED_MARKER])
            log.info("alerts: seeded %s with %d pools, sending from the next match on", kind, len(hits))
            return
        if not hits:
            return
        sent = await self._already_sent(kind)
        fresh = [a for a in hits if a not in sent]
        if not fresh:
            return
        delivered: list[str] = []
        for address in fresh[:MAX_PER_CYCLE]:
            if await asyncio.to_thread(
                _post, self.token, self.chat_id, message(rows[address], kind),
                buttons(address, rows[address].get("flags") or []),
            ):
                delivered.append(address)
        await self._remember(kind, delivered)
        if delivered:
            log.info("alerts: sent %d %s", len(delivered), kind)


HELP_TEXT = (
    "🤖 <b>Quant LP bot</b>\n"
    "Bot ini mengirim alert pool DLMM dari engine.\n\n"
    "/flags — daftar semua flag dan artinya\n"
    "Tombol <b>ℹ️ Info flag</b> di bawah alert menjelaskan flag pool itu."
)


def _call(token: str, method: str, fields: dict[str, Any], timeout: float = 15) -> Any:
    payload = urllib.parse.urlencode(fields).encode()
    request = urllib.request.Request(f"https://api.telegram.org/bot{token}/{method}", data=payload)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.load(response).get("result")


def reply_for(update: dict[str, Any], chat_id: str) -> tuple[str, str | None] | None:
    """(text, callback id to acknowledge) for an update from our chat, or None to ignore it. Anyone can message a
    public bot; only the configured chat gets answers."""
    callback = update.get("callback_query")
    if callback:
        if str(((callback.get("message") or {}).get("chat") or {}).get("id")) != chat_id:
            return None
        keys = flag_info.decode(str(callback.get("data") or ""))
        return flag_info.explain(keys), str(callback.get("id"))
    msg = update.get("message") or {}
    if str((msg.get("chat") or {}).get("id")) != chat_id:
        return None
    command = str(msg.get("text") or "").split("@")[0].split(" ")[0].lower()
    if command == "/flags":
        return flag_info.glossary(), None
    if command in ("/start", "/help"):
        return HELP_TEXT, None
    return None


async def serve_commands(token: str, chat_id: str) -> None:
    """Long-poll Telegram for /flags, /help and Info flag button taps. getUpdates holds the request up to 25s, so
    this costs one idle request per 25s."""
    offset = 0
    while True:
        try:
            updates = await asyncio.to_thread(
                _call, token, "getUpdates",
                {"offset": offset, "timeout": 25, "allowed_updates": json.dumps(["message", "callback_query"])},
                35,
            )
            for update in updates or []:
                offset = max(offset, int(update["update_id"]) + 1)
                answer = reply_for(update, chat_id)
                if not answer:
                    continue
                text, callback_id = answer
                if callback_id:
                    await asyncio.to_thread(_call, token, "answerCallbackQuery", {"callback_query_id": callback_id})
                await asyncio.to_thread(_post, token, chat_id, text)
        except asyncio.CancelledError:
            raise
        except Exception as err:  # network blips must not end the loop
            log.warning("telegram polling failed: %s", err)
            await asyncio.sleep(10)


def _get_me(token: str) -> dict[str, Any] | None:
    """Ask Telegram who this token belongs to, so a typo is caught before anything else."""
    try:
        with urllib.request.urlopen(f"https://api.telegram.org/bot{token}/getMe", timeout=15) as response:
            body = json.load(response)
        return body.get("result") if body.get("ok") else None
    except (urllib.error.URLError, TimeoutError, ValueError):
        return None


def main() -> None:
    """Check the Telegram setup without ever printing the token: uv run python -m app.alerts [--send]"""
    import argparse

    parser = argparse.ArgumentParser(description="Check Telegram alert credentials, optionally send a test message")
    parser.add_argument("--send", action="store_true", help="send a test message to the configured chat")
    args = parser.parse_args()

    token, chat_id = config.TELEGRAM_BOT_TOKEN, config.TELEGRAM_CHAT_ID
    print(f"ALERTS_ENABLED   : {config.ALERTS_ENABLED}")
    print(f"TELEGRAM_BOT_TOKEN: {'terisi' if token else 'KOSONG'}")
    print(f"TELEGRAM_CHAT_ID  : {'terisi' if chat_id else 'KOSONG'}")
    print(f"ALERT_KINDS       : {', '.join(config.ALERT_KINDS) or '(kosong)'}")
    if not token or not chat_id:
        print("\nAlert MATI. Isi TELEGRAM_BOT_TOKEN dan TELEGRAM_CHAT_ID di .env, lalu restart engine.")
        return
    me = _get_me(token)
    if not me:
        print("\nToken ditolak Telegram (getMe gagal). Periksa lagi token dari @BotFather.")
        return
    print(f"\nBot terhubung: @{me.get('username')} ({me.get('first_name')})")
    if not args.send:
        print("Tambahkan --send untuk mengirim pesan uji ke chat tersebut.")
        return
    ok = _post(token, chat_id, "✅ <b>Uji koneksi</b>\nAlert quant engine siap mengirim pesan.")
    print("Pesan uji terkirim." if ok else "Gagal mengirim. Pastikan chat id benar dan bot sudah Anda ajak bicara.")


if __name__ == "__main__":
    main()
