"""Heuristic LP plan per pool: risk tier, strategy, price range, position size and exit rules.

Rules of thumb, not a model. Every number here is a parameter to validate with app.backtest.
Uses technical indicators on 30m candles when available (regime, ATR, Bollinger, Donchian),
falling back to realized volatility and 1h change from recorded prices.
"""

import math
from dataclasses import dataclass
from typing import Any

from .indicators import CANDLES_PER_HOUR
from .tiers import classify_tier, excluded_reason, volatility_pct

# SDK DEFAULT_BIN_PER_POSITION; wider ranges need several positions (more rent, more txs).
BINS_PER_POSITION = 70

# A breakout level closer than this (or 1 ATR, whichever is larger) is noise: paper trading showed a channel
# edge 0.4% above entry closing positions within a minute while the range itself spanned +9%.
MIN_BREAKOUT_DISTANCE_PCT = 2.0

# Paper trading closed positions after 0.7h on average, before fees could pay back ~0.9% of entry/exit costs.
DEFAULT_MIN_HOLD_HOURS = 2.0
# fee_decay compares the fee rate averaged over this many hours, not one snapshot.
FEE_RATE_AVG_HOURS = 2.0


def breakout_levels(
    low_pct: float | None, high_pct: float | None, atr_pct: float | None, buffer_pct: float | None
) -> tuple[float | None, float | None]:
    """Donchian breakout exit levels relative to entry (channel +/- buffer).

    A side is dropped when price already sits outside the channel on that side, or when the level is
    closer than max(MIN_BREAKOUT_DISTANCE_PCT, 1 ATR) to the entry price.
    """
    if buffer_pct is None:
        return None, None
    min_distance = max(MIN_BREAKOUT_DISTANCE_PCT, atr_pct or 0.0)
    below = low_pct - buffer_pct if low_pct is not None else None
    above = high_pct + buffer_pct if high_pct is not None else None
    return (
        round(below, 1) if below is not None and below <= -min_distance else None,
        round(above, 1) if above is not None and above >= min_distance else None,
    )


@dataclass(frozen=True)
class PlanParams:
    portfolio_usd: float
    max_position_pct: float
    hold_hours: float
    max_tvl_share: float = 0.02  # never be more than 2% of pool TVL
    out_of_range_minutes: float = 20.0
    fee_decay_ratio: float = 0.25  # exit when fee rate falls below 25% of entry rate
    # Chosen with app.experiment on 7 days of candles (see README): a breakout buffer or no breakout exit
    # made results worse; the pump filter helped slightly.
    pump_threshold_pct: float | None = 30.0  # avoid entries after a 1h pump this large (None = off)
    breakout_buffer_pct: float | None = 0.0  # exit beyond Donchian channel +/- buffer (None = no breakout exit)
    max_atr_pct: float | None = None  # hard cap on 30m ATR; off by default, tiers size risk instead
    curve_max_atr_pct: float = 1.5  # ranging + ATR below this -> Curve
    # Position size per risk tier, as a fraction of max_position_pct.
    low_size_mult: float = 1.0
    medium_size_mult: float = 0.6
    high_size_mult: float = 0.3
    # Until this many hours only stop-loss and out-of-range exits apply.
    min_hold_hours: float = DEFAULT_MIN_HOLD_HOURS
    # Enter only when fees expected over min_hold_hours are at least this multiple of round-trip costs.
    min_fee_cost_ratio: float = 2.0
    # Never enter when the round trip itself costs more than this share of the position.
    max_round_trip_cost_pct: float = 1.5
    # Upper bound on the plan stop-loss (after any profile multiplier).
    max_stop_loss_pct: float = 10.0
    # Position sizing, mirroring paper trading: a floor (fixed costs sink tiny positions) and a minimum below
    # which the trade is skipped. Both are still capped by max_tvl_share.
    position_floor_usd: float = 0.0
    min_position_usd: float = 0.0
    # Structural variants (app.experiment): cap the range width in bins, only enter while the market is ranging,
    # or provide liquidity on one side only ("quote"), which skips the entry swap and base-token exposure.
    max_bins: int | None = None
    require_ranging: bool = False
    force_side: str | None = None
    # Hours of fees the cost gate counts; None = max(min_hold_hours, 1). On 7 days of candles with costs a 1h gate
    # (+1.5%/trade, 119 trades) beat a 2h gate (+0.2%, 357 trades): the stricter gate drops thin-fee pools.
    fee_gate_hours: float | None = 1.0
    # Scales the plan's stop-loss (risk profiles: tighter < 1 < looser).
    stop_loss_mult: float = 1.0


def _clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


def bins_for_width(width_pct: float, bin_step: int) -> int:
    """Bins needed above the active bin for the price to rise by `width_pct`."""
    if width_pct <= 0:
        return 0
    return math.ceil(math.log(1 + width_pct / 100) / math.log(1 + bin_step / 10_000))


def bins_below(width_pct: float, bin_step: int) -> int:
    """Bins needed below the active bin for the price to fall by `width_pct`.

    A fall of w% multiplies price by (1 - w), so it needs ln(1 / (1 - w)) worth of bins: more than the
    same percentage rise (a -20% move needs ln 1.25, a +20% move only ln 1.2).
    """
    if width_pct <= 0:
        return 0
    fraction = min(width_pct, 99.0) / 100
    return math.ceil(-math.log(1 - fraction) / math.log(1 + bin_step / 10_000))


def _skip(action: str, reason: str, regime: str | None) -> dict[str, Any]:
    return {"action": action, "reason": reason, "tier": None, "regime": regime}


def plan_position(
    *,
    bin_step: int,
    tvl: float,
    score: float,
    safety: float,
    flags: list[str],
    change_pct_1h: float | None,
    realized_vol_pct_1h: float | None,
    fee_for_position_pct_day: float,
    params: PlanParams,
    market: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """`score` ranks pools within a tier; it does not gate entry."""
    m = market or {}
    regime = m.get("regime")
    flagset = set(flags)
    change = change_pct_1h if change_pct_1h is not None else m.get("change_1h_pct")
    atr = m.get("atr_pct")

    reason = excluded_reason(flags, safety)
    if reason:
        return _skip("avoid", reason, regime)
    if change is not None and change <= -15:
        return _skip("avoid", "Harga sedang dump (≤ -15% dalam 1 jam)", regime)
    if params.pump_threshold_pct is not None and change is not None and change >= params.pump_threshold_pct:
        return _skip("avoid", f"Harga sedang pump (≥ +{params.pump_threshold_pct:g}% dalam 1 jam)", regime)
    if {"strong_downtrend", "sell_pressure"} <= flagset:
        return _skip("avoid", "Tren turun kuat dan tekanan jual dominan", regime)
    if params.max_atr_pct is not None and atr is not None and atr > params.max_atr_pct:
        return _skip("avoid", f"Terlalu volatil (ATR 30m > {params.max_atr_pct:g}%)", regime)

    # Expected move over the holding horizon; take the wider of the two estimates.
    widths = []
    if realized_vol_pct_1h is not None:
        widths.append(2 * realized_vol_pct_1h * math.sqrt(params.hold_hours))
    if atr is not None:
        widths.append(1.5 * atr * math.sqrt(params.hold_hours * CANDLES_PER_HOUR))
    vol = volatility_pct(atr, realized_vol_pct_1h)
    if not widths or vol is None:
        return _skip("wait", "Riwayat harga/candle belum cukup", regime)

    tier, tier_reason = classify_tier(safety=safety, flags=flags, tvl=tvl, vol_pct=vol, regime=regime)
    if tier is None:
        return _skip("avoid", tier_reason, regime)

    notes: list[str] = []
    width = max(widths)
    if m.get("bb_squeeze"):
        width *= 1.3
        notes.append("Bollinger squeeze: volatilitas bisa meledak, range dilebarkan 30%")
    width = _clamp(width, max(2.0, 3 * bin_step / 100), 60.0)

    if params.require_ranging and regime != "ranging":
        return _skip("wait", "Hanya masuk saat rezim sideways", regime)

    if regime == "trending_down" or (regime is None and change is not None and change <= -5):
        strategy, side = "bid_ask", "quote"
        low, high = -width, 0.0
        note = "Tren turun: pasang SOL/USDC saja di bawah harga, akumulasi bertahap saat turun"
        if (m.get("rsi") or 50) < 30:
            notes.append("RSI oversold: pantulan mungkin, tetap akumulasi bertahap")
    elif regime == "trending_up" or (regime is None and change is not None and change >= 10):
        strategy, side = "spot", "both"
        low, high = -width * 0.5, width
        note = "Tren naik: range condong ke atas, jangan kejar pump"
        if (m.get("rsi") or 50) > 75:
            notes.append("RSI overbought: risiko koreksi tajam")
    elif (regime == "ranging" and atr is not None and atr < params.curve_max_atr_pct) or (
        regime is None and realized_vol_pct_1h is not None and realized_vol_pct_1h < 3
    ):
        strategy, side = "curve", "both"
        low, high = -width, width
        note = "Sideways dan tenang: likuiditas dipusatkan di sekitar harga"
    elif regime == "ranging":
        strategy, side = "spot", "both"
        low, high = -width, width
        note = "Sideways tapi bergejolak: sebar rata di range"
    else:
        strategy, side = "spot", "both"
        low, high = -width, width
        note = "Arah belum jelas: sebar rata di range"

    if params.force_side == "quote":
        strategy, side = "bid_ask", "quote"
        low, high = -width, 0.0
        note = "Satu sisi: hanya token quote di bawah harga, tanpa swap ke token dasar saat masuk"
    if params.max_bins is not None:
        # Both sides round up to whole bins, so one scaling pass can still land a bin over the cap.
        for _ in range(4):
            spread = bins_below(-low, bin_step) + bins_for_width(high, bin_step) + 1
            if spread <= params.max_bins:
                break
            low, high = low * params.max_bins / spread, high * params.max_bins / spread

    bins = bins_below(-low, bin_step) + bins_for_width(high, bin_step) + 1
    tier_mult = {"low": params.low_size_mult, "medium": params.medium_size_mult, "high": params.high_size_mult}[tier]
    size_pct = params.max_position_pct * tier_mult * _clamp(safety / 30, 0, 1)
    size_usd = params.portfolio_usd * size_pct / 100
    tvl_cap = tvl * params.max_tvl_share
    capped = size_usd > tvl_cap
    size_usd = min(size_usd, tvl_cap)

    breakout_below, breakout_above = breakout_levels(
        m.get("donchian_low_pct"), m.get("donchian_high_pct"), atr, params.breakout_buffer_pct
    )

    return {
        "action": "enter",
        "reason": None,
        "tier": tier,
        "tier_reason": tier_reason,
        "regime": regime,
        "strategy": strategy,
        "side": side,
        "note": note,
        "notes": notes,
        "range_low_pct": round(low, 1),
        "range_high_pct": round(high, 1),
        "bins": bins,
        "positions": math.ceil(bins / BINS_PER_POSITION),
        "size_usd": round(size_usd, 2),
        "size_pct": round(size_pct, 2),
        "size_capped_by_tvl": capped,
        "expected_fee_usd_day": round(size_usd * fee_for_position_pct_day / 100, 2),
        "exit": {
            "stop_loss_pct": round(
                min(_clamp(0.75 * width, 5.0, 20.0) * params.stop_loss_mult, params.max_stop_loss_pct), 1
            ),
            "out_of_range_minutes": params.out_of_range_minutes,
            "fee_decay_ratio": params.fee_decay_ratio,
            "max_hold_hours": max(params.hold_hours * 2, params.min_hold_hours),
            "min_hold_hours": params.min_hold_hours,
            # Close beyond the recent channel (plus a buffer against wicks) = breakout against the position.
            "breakout_below_pct": breakout_below,
            "breakout_above_pct": breakout_above,
        },
    }


def cost_gate_ok(cost_pct: float, fee_pct_day: float, hours: float, ratio: float) -> bool:
    """Fees expected over `hours` are at least `ratio` times the round-trip cost (no cost = pass)."""
    return cost_pct <= 0 or fee_pct_day * hours / 24 >= ratio * cost_pct


def apply_cost_gate(plan: dict[str, Any], cost_pct: float, fee_pct_day: float, params: PlanParams) -> dict[str, Any]:
    """Turn an entry plan into "wait" when fees expected over the minimum hold do not cover
    `min_fee_cost_ratio` times the round-trip cost. Keeps the estimate on the plan either way."""
    if plan.get("action") != "enter":
        return plan
    hours = params.fee_gate_hours if params.fee_gate_hours is not None else max(params.min_hold_hours, 1.0)
    fee_pct = fee_pct_day * hours / 24
    plan = dict(plan, round_trip_cost_pct=round(cost_pct, 3), fee_over_min_hold_pct=round(fee_pct, 3))
    if cost_pct > params.max_round_trip_cost_pct:
        skipped = _skip("wait", f"Biaya bolak-balik {cost_pct:.2f}% di atas batas {params.max_round_trip_cost_pct:g}%",
                        plan.get("regime"))
        skipped.update(round_trip_cost_pct=plan["round_trip_cost_pct"], gated_tier=plan.get("tier"))
        return skipped
    if not cost_gate_ok(cost_pct, fee_pct_day, hours, params.min_fee_cost_ratio):
        skipped = _skip(
            "wait",
            f"Fee {hours:g} jam ~{fee_pct:.2f}% belum menutup {params.min_fee_cost_ratio:g}x biaya {cost_pct:.2f}%",
            plan.get("regime"),
        )
        skipped.update(round_trip_cost_pct=plan["round_trip_cost_pct"], fee_over_min_hold_pct=plan["fee_over_min_hold_pct"],
                       gated_tier=plan.get("tier"))
        return skipped
    return plan
