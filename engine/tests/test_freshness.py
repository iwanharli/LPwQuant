from app.freshness import SOURCES, freshness_status

MINUTE_MS = 60_000


def test_status_by_age_and_requirement():
    now = 100 * MINUTE_MS
    assert freshness_status(now - 4 * MINUTE_MS, now, 5 * 60, True) == "ok"
    assert freshness_status(now - 6 * MINUTE_MS, now, 5 * 60, True) == "stale"
    assert freshness_status(None, now, 5 * 60, True) == "stale"  # required source never produced data
    assert freshness_status(None, now, 5 * 60, False) == "off"  # optional source not configured


def test_sources_are_unique_and_core_ones_required():
    keys = [s.key for s in SOURCES]
    assert len(keys) == len(set(keys))
    required = {s.key for s in SOURCES if s.required}
    assert {"pool_snapshots", "pool_metrics", "candles"} <= required
