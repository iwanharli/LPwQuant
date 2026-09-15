import math

from app.lp_study import Record, position_record, realization

NOW = 1_800_000_000.0
POOL = {"name": "MEME-SOL", "tvl": 99_900.0, "fees_24h": 1_000.0}


def usd(value):
    return {"total": {"usd": str(value)}}


def api_position(**overrides):
    pos = {
        "allTimeDeposits": usd(100), "allTimeFees": usd(0.5), "createdAt": NOW - 12 * 3600, "closedAt": NOW,
        "isClosed": True, "lowerBinId": -10, "upperBinId": 19,
    }
    pos.update(overrides)
    return pos


def test_closed_position_record():
    rec = position_record(api_position(), POOL, NOW, 7)
    assert rec is not None and rec.status == "closed" and rec.width_bins == 30
    assert math.isclose(rec.age_hours, 12) and math.isclose(rec.tvl_model_pct_day, 1_000 / 100_000 * 100)


def test_open_position_adds_unclaimed_fees():
    pos = api_position(isClosed=False, closedAt=None, allTimeFees=usd(0), unrealizedPnl={
        "unclaimedFeeTokenX": {"usd": "0.2"}, "unclaimedFeeTokenY": {"usd": "0.3"}})
    rec = position_record(pos, POOL, NOW, 7)
    assert rec is not None and rec.status == "open" and math.isclose(rec.fees_usd, 0.5)


def test_filters_small_young_and_old_positions():
    assert position_record(api_position(allTimeDeposits=usd(10)), POOL, NOW, 7) is None
    assert position_record(api_position(createdAt=NOW - 3600), POOL, NOW, 7) is None
    assert position_record(api_position(createdAt=NOW - 10 * 86400, closedAt=NOW - 9 * 86400), POOL, NOW, 7) is None


def test_realization_is_capital_time_weighted():
    # Model: 1%/day. A $100 position for 1 day earning $1 realizes 1.0; a $300 position for 1 day earning $1.5, 0.5.
    a = Record("P", "closed", 100.0, 1.0, 24.0, 30, 1.0)
    b = Record("P", "closed", 300.0, 1.5, 24.0, 30, 1.0)
    assert math.isclose(realization([a]), 1.0)
    assert math.isclose(realization([a, b]), 2.5 / 4.0)
    assert realization([]) is None
