from app import busy_hours


def _days(n, peak):
    return {d: [0.9 if h == peak else 0.1 / 23 for h in range(24)] for d in range(n)}


def test_repeating_pattern_is_stable_and_peaks_where_it_should():
    days = _days(20, 21)
    # a little day-to-day noise, so the split-half correlation is defined
    for d, prof in days.items():
        prof[(d % 5) + 2] += 0.01
    s = busy_hours.summarize(days)
    assert s["stable"] and s["days"] == 20 and 21 in s["peak_hours"]
    assert abs(sum(s["profile"]) - 100) < 1.5  # the fixture noise adds 1%


def test_pattern_that_moves_is_not_stable():
    days = {**_days(10, 3), **{d + 10: v for d, v in _days(10, 15).items()}}
    assert not busy_hours.summarize(days)["stable"]


def test_too_few_days_is_never_stable():
    assert not busy_hours.summarize(_days(6, 21))["stable"]
