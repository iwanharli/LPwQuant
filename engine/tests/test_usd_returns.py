import math

from app.backtest import SOL_MINT, quote_usd_factor, summarize

USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
SOL_SERIES = ([0, 1_800_000, 3_600_000], [100.0, 95.0, 90.0])


def test_stablecoin_quote_is_flat_in_usd():
    assert quote_usd_factor(USDC, SOL_SERIES, 0, 3_600_000) == 1.0


def test_sol_quote_follows_sol_price():
    assert math.isclose(quote_usd_factor(SOL_MINT, SOL_SERIES, 0, 3_600_000), 0.9)
    assert math.isclose(quote_usd_factor(SOL_MINT, SOL_SERIES, 1_000_000, 2_000_000), 95.0 / 100.0)  # candle in progress


def test_unknown_quote_or_uncovered_period():
    assert quote_usd_factor("SomeOtherQuoteMint", SOL_SERIES, 0, 3_600_000) is None
    assert quote_usd_factor(SOL_MINT, ([], []), 0, 1) is None
    assert quote_usd_factor(SOL_MINT, SOL_SERIES, -5, 3_600_000) is None


def test_summarize_reports_usd_means_when_available():
    base = {"fee_pct": 0.5, "il_vs_hodl_pct": -0.2, "hold_hours": 3.0, "exit_reason": "max_hold"}
    trades = [dict(base, return_pct=1.0, return_usd_pct=-9.1), dict(base, return_pct=2.0), dict(base, return_pct=3.0, return_usd_pct=3.0)]
    s = summarize(trades)
    assert s["usd_trades"] == 2 and math.isclose(s["mean_return_usd_pct"], -3.05)
    assert "mean_return_usd_pct" not in summarize([dict(base, return_pct=1.0)])
