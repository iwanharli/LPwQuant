import app.alerts as alerts

ROW = {
    "address": "PoolAddr",
    "name": "MEME-SOL",
    "market_cap": 470_160.0,
    "tvl": 125_870.0,
    "volume_24h": 269.34,
    "holders": 24,
    "score": 51.2,
    "pool_age_hours": 10.0,
    "fee_tvl_pct_24h": 1.2,
    "fee_for_position_pct_day": 120.0,
    "flags": ["new_pool", "unverified"],
    "market": {"atr_pct": 1.4},
    "security": {"top10_pct": 21.0, "mint_authority": True, "freeze_authority": False,
                 "lp_locked_pct": 100.0, "risks": ["Mint Authority still enabled", "Low Liquidity"]},
    "organic": {"organic_score": 0.0, "organic_label": "low", "verified": True, "bot_holders_pct": 0.0},
    "insights": {"tags": {"bundler": {"holding_pct": 0.0}, "sniper": {"holding_pct": 0.0}}},
    "plan_base": {"action": "enter", "round_trip_cost_pct": 0.5, "strategy": "spot",
                  "range_low_pct": -5.0, "range_high_pct": 5.0},
}


def test_new_pool_and_lp_filters():
    assert alerts.is_new_pool(ROW)
    assert not alerts.is_new_pool({**ROW, "pool_age_hours": 40.0})
    assert alerts.passes_lp_filters(ROW)
    # each LP default rejects on its own
    assert not alerts.passes_lp_filters({**ROW, "market": {"atr_pct": 9.0}})
    assert not alerts.passes_lp_filters({**ROW, "security": {**ROW["security"], "top10_pct": 60.0}})
    assert not alerts.passes_lp_filters({**ROW, "tvl": 1_000.0})
    # a pool that reports nothing must not slip through as if it passed
    assert not alerts.passes_lp_filters({**ROW, "market": {}})


def test_gate_matches_the_profile_rule():
    # 120%/day over a 1h window is 5%, against 2 x 0.5% cost: through.
    assert alerts.passes_gate(ROW)
    assert not alerts.passes_gate({**ROW, "fee_for_position_pct_day": 1.0})
    assert not alerts.passes_gate({**ROW, "plan_base": {**ROW["plan_base"], "action": "wait"}})
    assert not alerts.passes_gate({**ROW, "plan_base": {**ROW["plan_base"], "round_trip_cost_pct": 0.0}})


def test_message_has_the_numbers_and_escapes_html():
    text = alerts.message(ROW, "gate")
    assert "MEME-SOL" in text and "PoolAddr" in text
    assert "Holders 24" in text and "Top10 21.0%" in text
    assert "Mint AKTIF" in text and "Freeze mati" in text
    assert "Perhatikan" in text and "mint authority masih aktif" in text
    assert "app.meteora.ag/dlmm/PoolAddr" in str(alerts.buttons("PoolAddr"))
    clean = {**ROW, "security": {**ROW["security"], "mint_authority": False}}
    assert "Tidak ada tanda bahaya" in alerts.message(clean, "new_lp")
    nasty = alerts.message({**ROW, "name": "<script>&"}, "new_pool")
    assert "<script>" not in nasty and "&lt;script&gt;&amp;" in nasty


def test_disabled_without_credentials(monkeypatch):
    monkeypatch.setattr(alerts.config, "TELEGRAM_BOT_TOKEN", "")
    monkeypatch.setattr(alerts.config, "TELEGRAM_CHAT_ID", "")
    assert alerts.Alerter(db=object()).enabled is False
    monkeypatch.setattr(alerts.config, "TELEGRAM_BOT_TOKEN", "t")
    monkeypatch.setattr(alerts.config, "TELEGRAM_CHAT_ID", "c")
    monkeypatch.setattr(alerts.config, "ALERTS_ENABLED", True)
    monkeypatch.setattr(alerts.config, "ALERT_KINDS", ("gate",))
    assert alerts.Alerter(db=object()).enabled is True


class FakeDb:
    """Just enough of an asyncpg pool for the seeding logic."""

    def __init__(self, rows=()):
        self.rows = set(rows)  # (kind, address)
        self.posted: list[str] = []

    async def fetch(self, _sql, kind):
        return [{"address": a} for k, a in self.rows if k == kind]

    async def fetchval(self, _sql, kind):
        return 1 if any(k == kind for k, _ in self.rows) else None

    async def executemany(self, _sql, args):
        self.rows.update((k, a) for k, a in args)


def _alerter(db, monkeypatch, sent_ok=True):
    monkeypatch.setattr(alerts.config, "TELEGRAM_BOT_TOKEN", "t")
    monkeypatch.setattr(alerts.config, "TELEGRAM_CHAT_ID", "c")
    monkeypatch.setattr(alerts.config, "ALERTS_ENABLED", True)
    monkeypatch.setattr(alerts.config, "ALERT_KINDS", ("gate",))
    a = alerts.Alerter(db)
    monkeypatch.setattr(alerts, "_post", lambda token, chat, text, markup=None: (db.posted.append(text), sent_ok)[1])
    return a


def test_a_kind_that_matches_nothing_still_counts_as_seeded(monkeypatch):
    # The bug this covers: "gate" matched nothing on the first cycle, so it looked like it had never run, and its
    # first real candidate would have been recorded as seeding instead of sent.
    import asyncio

    db = FakeDb()
    a = _alerter(db, monkeypatch)
    asyncio.run(a.on_refresh({}))  # nothing qualifies yet
    assert ("gate", alerts.SEED_MARKER) in db.rows
    assert db.posted == []

    asyncio.run(a.on_refresh({"PoolAddr": ROW}))  # the first real candidate must be sent, not swallowed
    assert len(db.posted) == 1 and "PoolAddr" in db.posted[0]
    assert ("gate", "PoolAddr") in db.rows


def test_first_cycle_with_matches_seeds_them_silently(monkeypatch):
    import asyncio

    db = FakeDb()
    a = _alerter(db, monkeypatch)
    asyncio.run(a.on_refresh({"PoolAddr": ROW}))
    assert db.posted == []                      # no burst on the very first cycle
    assert ("gate", "PoolAddr") in db.rows
    asyncio.run(a.on_refresh({"PoolAddr": ROW}))
    assert db.posted == []                      # and it is not re-sent every cycle


def test_existing_rows_from_before_the_marker_count_as_seeded(monkeypatch):
    import asyncio

    db = FakeDb([("gate", "OldPool")])          # recorded before SEED_MARKER existed
    a = _alerter(db, monkeypatch)
    asyncio.run(a.on_refresh({"PoolAddr": ROW}))
    assert len(db.posted) == 1                  # treated as already seeded, so this is a real alert


def test_stale_alert_fires_on_transitions_only(monkeypatch):
    import asyncio

    db = FakeDb()
    a = _alerter(db, monkeypatch)
    a.kinds = ("stale",)
    reports = iter([
        {"stale": [], "items": []},
        {"stale": ["Snapshot pool (Meteora)"], "items": [{"label": "Snapshot pool (Meteora)", "age_sec": 900}]},
        {"stale": ["Snapshot pool (Meteora)"], "items": [{"label": "Snapshot pool (Meteora)", "age_sec": 1200}]},
        {"stale": [], "items": []},
    ])

    async def fake_check(_db, _now):
        return next(reports)

    import app.freshness as freshness
    monkeypatch.setattr(freshness, "check_freshness", fake_check)
    step = alerts.FRESHNESS_EVERY_MS
    for i in range(4):
        asyncio.run(a.check_freshness((i + 1) * step))
    assert len(db.posted) == 2  # went stale once, recovered once; staying stale is not re-sent
    assert "Data basi" in db.posted[0] and "15 mnt" in db.posted[0]
    assert "Data pulih" in db.posted[1]


def test_flags_are_readable_and_the_info_button_round_trips():
    text = alerts.message(ROW, "new_pool")
    assert "new_pool" not in text and "🟡 Pool baru" in text and "🔵 Unverified" in text
    markup = alerts.buttons("PoolAddr", ROW["flags"])
    data = markup["inline_keyboard"][-1][0]["callback_data"]
    assert len(data.encode()) <= 64
    assert alerts.flag_info.decode(data) == ["new_pool", "unverified"]
    assert len(alerts.buttons("PoolAddr", [])["inline_keyboard"]) == 1  # no flags, no info button


def test_bot_answers_only_its_own_chat():
    tap = {"callback_query": {"id": "9", "data": "fi:1", "message": {"chat": {"id": 5}}}}
    text, callback_id = alerts.reply_for(tap, "5")
    assert "Mint aktif" in text and callback_id == "9"
    assert alerts.reply_for(tap, "6") is None
    command = {"message": {"chat": {"id": 5}, "text": "/flags"}}
    assert "Daftar flag" in alerts.reply_for(command, "5")[0]
    assert len(alerts.flag_info.glossary()) < 4096  # Telegram's message limit
    assert alerts.reply_for({"message": {"chat": {"id": 5}, "text": "halo"}}, "5") is None
