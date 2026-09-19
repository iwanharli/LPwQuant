from app import limit_recs


def c(high, low, close):
    return {"high": high, "low": low, "close": close}


def test_replay_counts_a_full_cycle_and_a_stop():
    # buy at 99 (1% below 100), sell at 99 * 1.02 = 100.98
    assert limit_recs.replay([c(100, 100, 100), c(100, 98.9, 99.5), c(101.5, 99.4, 101)], 1.0)["cycles"] == 1
    # after buying at 99, a drop through 99 * 0.97 = 96.03 is a stop
    r = limit_recs.replay([c(100, 100, 100), c(100, 98.9, 99.5), c(99, 95, 96)], 1.0)
    assert r["stops"] == 1 and r["return_pct"] < 0


def test_a_bar_touching_both_stop_and_target_counts_as_the_stop():
    r = limit_recs.replay([c(100, 100, 100), c(100, 98.9, 99.5), c(102, 95, 100)], 1.0)
    assert r["stops"] == 1 and r["cycles"] == 0


def test_trending_down_pool_is_not_recommended():
    row = {"name": "X-SOL", "flags": [], "security": {"top10_pct": 10}, "pool_age_hours": 48, "tvl": 50000,
           "volume_24h": 500000, "market": {"atr_pct": 2, "regime": "trending_down", "reversal_rate": 0.6}}
    assert not limit_recs.eligible(row)[0]
    assert limit_recs.eligible({**row, "market": {**row["market"], "regime": "ranging"}})[0]
