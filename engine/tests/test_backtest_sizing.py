from app.backtest import default_params, trade_size
from app.recommend import PlanParams

PARAMS = PlanParams(portfolio_usd=500, max_position_pct=5, hold_hours=4, position_floor_usd=100.0,
                    min_position_usd=25.0)


def test_size_is_floored_like_paper_trading():
    assert trade_size(5.5, 1_000_000, PARAMS) == 100.0  # tiny plan size lifted to the floor
    assert trade_size(250.0, 1_000_000, PARAMS) == 250.0  # larger plans keep their size


def test_tvl_share_caps_the_floor():
    assert trade_size(5.5, 2_000, PARAMS) == 40.0  # 2% of $2k TVL
    assert trade_size(5.5, 1_000, PARAMS) == 0.0  # $20 < $25 minimum: skipped


def test_defaults_match_paper_trading():
    from app import config

    p = default_params()
    assert p.portfolio_usd == config.PAPER_START_EQUITY_USD
    assert p.position_floor_usd == config.PAPER_POSITION_FLOOR_USD
    assert p.min_position_usd == config.PAPER_MIN_POSITION_USD
    assert p.max_stop_loss_pct == config.MAX_STOP_LOSS_PCT
