from app.validation import (
    HOUR_MS,
    bootstrap_diff_ci,
    bootstrap_mean_ci,
    cluster_by_hour,
    trades_between,
    walk_forward,
)


def trade(hour: float, ret: float, hold_hours: float = 1.0) -> dict:
    entry = int(hour * HOUR_MS)
    return {"entry_ts": entry, "exit_ts": entry + int(hold_hours * HOUR_MS), "return_pct": ret,
            "fee_pct": 0.0, "il_vs_hodl_pct": 0.0, "hold_hours": hold_hours, "exit_reason": "max_hold"}


def test_cluster_by_hour_groups_same_hour_entries():
    clusters = cluster_by_hour([trade(0, 1), trade(0.5, 2), trade(1, 3)])
    assert clusters == {0: [1, 2], 1: [3]}


def test_bootstrap_ci_brackets_mean_and_detects_clear_edges():
    positive = [trade(h, 1.0 + (0.2 if h % 2 else -0.2)) for h in range(50)]
    ci = bootstrap_mean_ci(positive)
    assert ci["low"] <= ci["mean"] <= ci["high"] and ci["low"] > 0

    noisy = [trade(h, 1.0 if h % 2 else -1.0) for h in range(50)]
    ci = bootstrap_mean_ci(noisy)
    assert ci["low"] < 0 < ci["high"]

    single = bootstrap_mean_ci([trade(0, 1.0), trade(0.2, 2.0)])
    assert single["low"] is None and single["clusters"] == 1


def test_bootstrap_diff_is_paired_over_hours():
    a = [trade(h, 1.0) for h in range(40)]
    b = [trade(h, 0.0) for h in range(40)]
    diff = bootstrap_diff_ci(a, b)
    assert diff["diff"] == 1.0 and diff["low"] == diff["high"] == 1.0 and diff["p_a_better"] == 1.0


def test_trades_between_purges_exits_after_window():
    trades = [trade(1, 0, hold_hours=1), trade(9, 0, hold_hours=3)]
    assert len(trades_between(trades, 0, 10 * HOUR_MS, purge=False)) == 2
    assert len(trades_between(trades, 0, 10 * HOUR_MS, purge=True)) == 1


def test_walk_forward_selects_on_train_and_scores_on_test():
    # "early" wins in the first 40h then collapses; "steady" is modest throughout.
    # Fold 1 trains on [0h, 48h): early mean +1.17 > 0.5, so early is chosen and fails on [48h, 72h).
    # Fold 2 trains on [24h, 72h): early mean -1.33 < 0.5, so steady is chosen.
    early = [trade(h, 2.0 if h < 40 else -3.0, 0.5) for h in range(96)]
    steady = [trade(h, 0.5, 0.5) for h in range(96)]
    wf = walk_forward({"early": early, "steady": steady}, 0, 96 * HOUR_MS, 48 * HOUR_MS, 24 * HOUR_MS)
    assert [f["chosen"] for f in wf["folds"]] == ["early", "steady"]
    first_test = wf["folds"][0]["test"]
    assert first_test["trades"] == 24 and first_test["mean_return_pct"] < 0  # overfit choice fails out of sample
    assert wf["oos"]["trades"] == 48


def test_conservative_ci_takes_the_wider_of_hour_and_pool_clustering():
    from app.validation import conservative_mean_ci, bootstrap_mean_ci

    # One pool entered many times in different hours: hour clustering sees many observations, pool sees one.
    trades = [{"address": "ELON", "entry_ts": h * 3_600_000, "return_pct": r}
              for h, r in enumerate([-15, -12, -18, -10, -20])]
    trades += [{"address": f"P{i}", "entry_ts": i * 3_600_000, "return_pct": 1.0} for i in range(10)]
    ci = conservative_mean_ci(trades, n_boot=500)
    hour = bootstrap_mean_ci(trades, n_boot=500, by="hour")
    pool = bootstrap_mean_ci(trades, n_boot=500, by="pool")
    assert ci["low"] == min(hour["low"], pool["low"]) and ci["high"] == max(hour["high"], pool["high"])
    assert ci["pool_clusters"] == 11 and ci["hour_clusters"] == 10
