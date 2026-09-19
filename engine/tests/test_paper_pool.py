from app.paper_pool import lp_value, token_share


def test_lp_value_at_entry_is_capital():
    assert abs(lp_value(1.0) - 1.0) < 1e-9


def test_lp_value_falls_with_price_and_caps_above_range():
    assert lp_value(0.5) < lp_value(0.9) < 1.0
    assert lp_value(2.0) > 1.0  # everything sold on the way up, at bin prices above the entry


def test_token_share_all_token_below_range():
    assert abs(token_share(0.2) - 1.0) < 1e-9
    assert token_share(2.0) == 0.0
