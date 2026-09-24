from app.indicators import Candle, bollinger_bands, macd_histogram, rsi, supertrend


def candles(closes: list[float]) -> list[Candle]:
    return [Candle(ts=i * 900_000, open=c, high=c * 1.01, low=c * 0.99, close=c, volume=1.0) for i, c in enumerate(closes)]


def test_supertrend_follows_a_rising_market():
    st = supertrend(candles([100 + i for i in range(40)]))
    assert st is not None and st["up"] is True and st["line"] < 139


def test_supertrend_turns_down_after_a_crash():
    st = supertrend(candles([100 + i for i in range(30)] + [130 - 6 * i for i in range(12)]))
    assert st is not None and st["up"] is False


def test_macd_histogram_turns_positive_when_price_turns_up():
    hist = macd_histogram([100 - i for i in range(60)] + [40 + 3 * i for i in range(20)])
    assert hist is not None and hist[-1] > 0


def test_rsi_period_two_is_extreme_after_two_up_closes():
    assert (rsi([10, 9, 8, 7, 6, 5, 9, 12], 2) or 0) > 90


def test_bollinger_bands_bracket_the_mean():
    b = bollinger_bands([10 + (i % 3) for i in range(30)])
    assert b is not None and b["lower"] < b["mid"] < b["upper"]


def test_one_sided_position_starts_as_quote_and_ends_as_token():
    from app.panda import position_value

    quote, token = position_value(1000.0, 1.0)  # price unchanged: nothing bought yet
    assert abs(quote - 1000.0) < 1.0 and token < 1.0
    quote, token = position_value(1000.0, 0.05)  # price fell through the whole range
    assert quote < 1.0 and 0 < token < 1000.0


def test_position_loses_less_than_the_token_itself():
    """The point of buying down a wide range: at -50% the position is worth more than a token bought at the top."""
    from app.panda import position_value

    quote, token = position_value(1000.0, 0.5)
    assert 500.0 < quote + token < 1000.0


def test_screen_rejects_a_thin_pool():
    from app.panda import screen

    ok, why = screen({"name": "X-SOL", "security": {"score": 1}, "flags": [], "market_cap": 100.0})
    assert not ok and "market cap" in why
    ok, why = screen({"name": "X-USDT", "security": {"score": 1}, "flags": []})
    assert not ok and "SOL/USDC" in why


def test_supertrend_counts_candles_since_the_break():
    rising_after_crash = [100 - i for i in range(25)] + [75 + 4 * i for i in range(20)]
    st = supertrend(candles(rising_after_crash))
    assert st is not None and st["up"] is True
    assert st["bars_since_flip"] is not None and st["bars_since_flip"] > 0


def test_entry_takes_a_fresh_break_even_below_the_high():
    """The other trigger: the break itself, while the price is still within NEAR_HIGH_PCT of the high."""
    from app.panda import MAX_BARS_SINCE_BREAK, entry_signal

    fresh = candles([100 - i for i in range(25)] + [75 + 4 * i for i in range(5)])
    ok, why = entry_signal(fresh)
    assert MAX_BARS_SINCE_BREAK == 4
    assert ok, why


def test_entry_takes_a_price_at_its_high_even_when_the_break_is_old():
    """The corpus' own fullest write-up says "Entry: ATH. Bullish supertrend." -- a long-standing uptrend sitting at
    its high is the setup, not a disqualification."""
    from app.panda import entry_signal

    long_uptrend = candles([100 - i for i in range(25)] + [75 + 2 * i for i in range(40)])
    ok, why = entry_signal(long_uptrend)
    assert ok, why


def test_entry_refuses_an_old_break_that_has_fallen_from_the_high():
    from app.panda import entry_signal

    faded = candles([100 - i for i in range(25)] + [75 + 2 * i for i in range(40)] + [154 - 1.5 * i for i in range(6)])
    ok, why = entry_signal(faded)
    assert not ok and ("puncak" in why or "candle lalu" in why)


def test_range_behaviour_reads_time_in_range_and_where_it_ended():
    import asyncio

    from app import portfolio

    class FakeDb:
        async def fetch(self, *_args):
            # closes: inside, inside, below the range
            return [{"ts": 1000, "close": 10.0}, {"ts": 2000, "close": 11.0}, {"ts": 3000, "close": 4.0}]

    positions = [{"opened_at": 1000, "closed_at": 3000, "min_price": 9.0, "max_price": 12.0}]
    asyncio.run(portfolio.range_behaviour(FakeDb(), "pool", positions))
    assert positions[0]["in_range_pct"] == 2 / 3 * 100
    assert positions[0]["exit_side"] == "below"
    assert positions[0]["last_price"] == 4.0


def test_exit_needs_the_dump_to_have_happened_first():
    """Entry and exit share their ingredients: a break near the high is also when RSI(2) is hot and the price sits
    on the upper band. Without this gate the first five paper positions closed within five minutes."""
    from app.panda import MIN_DROP_BEFORE_EXIT_PCT, MIN_HOLD_MIN

    # A position still at its entry price, held for ten minutes, is not eligible.
    min_ratio, ratio, held_h = 1.0, 1.0, 10 / 60
    dropped = (1 - min(min_ratio, ratio)) * 100 >= MIN_DROP_BEFORE_EXIT_PCT
    assert not (dropped or held_h * 60 >= MIN_HOLD_MIN)

    # One that fell 5% below entry is, whatever the clock says.
    assert (1 - min(0.95, 0.98)) * 100 >= MIN_DROP_BEFORE_EXIT_PCT
