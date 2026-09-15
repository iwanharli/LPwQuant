from app.charts import merge_candles, profile_decision, trim_inactive_start, windows
from app.paper import PaperTrader
from app.profiles import PROFILE_BY_KEY, paper_config


def _cfg(key):
    """Profile config without the paper position floor, so sizing and gating rules are tested on their own."""
    from dataclasses import replace

    return replace(paper_config(PROFILE_BY_KEY[key]), position_floor_usd=0.0)

HOUR = 3600
EXIT = {"stop_loss_pct": 10.0, "out_of_range_minutes": 20.0, "fee_decay_ratio": 0.25, "max_hold_hours": 8.0,
        "breakout_below_pct": None, "breakout_above_pct": None, "min_hold_hours": 2.0}


def test_windows_cover_the_span_within_the_api_limit():
    spans = windows(100 * HOUR, 24, 6)
    assert spans[0] == (94 * HOUR, 100 * HOUR) and spans[-1] == (76 * HOUR, 82 * HOUR) and len(spans) == 4
    assert windows(100 * HOUR, 5, 6) == [(95 * HOUR, 100 * HOUR)]


def test_merge_candles_dedupes_window_edges():
    a = [{"ts": 1, "close": 1.0}, {"ts": 2, "close": 2.0}]
    b = [{"ts": 2, "close": 2.5}, {"ts": 3, "close": 3.0}]
    assert [c["ts"] for c in merge_candles([b, a])] == [1, 2, 3]


def _row(tier="medium", cost=0.5, fee_day=12.0, size=40.0):
    base = {"action": "enter", "tier": tier, "size_usd": size, "exit": dict(EXIT), "round_trip_cost_pct": cost}
    return {"address": "POOL", "tvl": 100_000.0, "fee_for_position_pct_day": fee_day, "plan_base": base,
            "plan": {"action": "wait", "reason": "gated"}}


def _trader(key):
    return PaperTrader(None, _cfg(key))  # type: ignore[arg-type]  # no DB needed


def test_profile_decision_reasons():
    row = _row()
    assert profile_decision(row, _trader("agresif"))["enter"] is True
    moderate = profile_decision(row, _trader("moderat"))
    assert moderate["enter"] is False and "biaya" in moderate["reason"]
    cons = profile_decision(_row(tier="high", fee_day=500.0), _trader("konservatif"))
    assert cons["enter"] is False and "Tier high" in cons["reason"]
    small = profile_decision(_row(fee_day=500.0, size=10.0), _trader("moderat"))
    assert small["enter"] is False and "minimum" in small["reason"]
    avoided = profile_decision({"address": "POOL", "plan": {"action": "avoid", "reason": "Rugpull"}}, _trader("agresif"))
    assert avoided["enter"] is False and avoided["reason"] == "Rugpull"


def test_trim_inactive_start_keeps_everything_from_the_first_trade():
    candles = [{"ts": 1, "volume": 0}, {"ts": 2, "volume": 0.0}, {"ts": 3, "volume": 5}, {"ts": 4, "volume": 0}]
    assert [c["ts"] for c in trim_inactive_start(candles)] == [3, 4]
    assert trim_inactive_start([{"ts": 1, "volume": 0}]) == [{"ts": 1, "volume": 0}]
