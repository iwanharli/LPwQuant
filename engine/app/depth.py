"""On-chain bin liquidity around the active bin, and the calibrated fee model.

The fee model is a TVL share scaled by a realization factor measured on real LP positions (see
REALIZATION_NARROW/WIDE). Bin depth is kept for new-bin-array rent and for display.

The ingestor writes `bins:latest` (see ingestor/src/bins.ts): per pool, non-empty bins as offsets from the
active bin with liquidity valued in token Y, plus which bin arrays exist (new ones cost non-refundable rent).
"""

import math
from dataclasses import dataclass
from typing import Any

BINS_PER_BIN_ARRAY = 70  # SDK MAX_BIN_ARRAY_SIZE
MAX_WINDOW_BINS = 35
DEPTH_MAX_AGE_MS = 15 * 60 * 1000

# Fee realization calibrated on real Meteora LP positions (python -m app.lp_study, 2026-09-16: 551 positions in
# 17 pools, fees per capital-day vs the TVL-share model). Positions earned the TVL share almost exactly with
# narrow ranges (1.04x) and much less with wide ranges (0.63x: more time out of range, liquidity in bins price
# rarely visits). The bin-depth share this module used before overstated realized fees ~2.4x, so the depth data
# no longer boosts fees; it still sizes new bin array rent and is shown on the dashboard.
NARROW_RANGE_BINS = 70
REALIZATION_NARROW = 1.0
REALIZATION_WIDE = 0.65


@dataclass(frozen=True)
class Depth:
    ts: int
    active_id: int
    bin_step: int
    array_lo: int
    array_hi: int
    initialized: frozenset[int]
    bins: dict[int, float]  # offset from active bin -> liquidity in token Y

    @classmethod
    def parse(cls, raw: dict[str, Any]) -> "Depth":
        return cls(
            ts=int(raw["ts"]),
            active_id=int(raw["active_id"]),
            bin_step=int(raw["bin_step"]),
            array_lo=int(raw["array_lo"]),
            array_hi=int(raw["array_hi"]),
            initialized=frozenset(int(i) for i in raw.get("initialized") or []),
            bins={int(off): float(v) for off, v in raw.get("bins") or []},
        )

    def fresh(self, now_ms: int) -> bool:
        return now_ms - self.ts <= DEPTH_MAX_AGE_MS


def window_bins(bin_step: int, move_pct: float | None) -> int:
    """Bins either side of the active bin that swaps typically cross: the bins spanned by a typical move
    (ATR or realized volatility), at least 1."""
    if not move_pct or move_pct <= 0 or bin_step <= 0:
        return 1
    bins = math.ceil(math.log(1 + move_pct / 100) / math.log(1 + bin_step / 10_000))
    return max(1, min(MAX_WINDOW_BINS, bins))


def depth_per_bin_y(depth: Depth, window: int) -> float:
    """Mean pool liquidity per bin (token Y) over the active bin +/- `window` bins."""
    total = sum(v for off, v in depth.bins.items() if -window <= off <= window)
    return total / (2 * window + 1)


def realization_factor(n_bins: int) -> float:
    """Share of the TVL-model fees a position of this width realizes (see NARROW_RANGE_BINS)."""
    return REALIZATION_NARROW if n_bins <= NARROW_RANGE_BINS else REALIZATION_WIDE


def calibrated_fee_share(position_value: float, tvl: float, n_bins: int) -> float:
    """Share of the pool's fees a position earns: its share of TVL, scaled by the realization for its width."""
    if position_value <= 0 or tvl <= 0:
        return 0.0
    return position_value / (tvl + position_value) * realization_factor(n_bins)


def fee_for_position_pct_day(fee_pct_day_of_tvl: float, tvl_usd: float, position_usd: float, n_bins: int) -> float:
    """Daily fees for a position over `n_bins`, as % of the position (calibrated TVL-share model)."""
    if position_usd <= 0 or tvl_usd <= 0 or n_bins <= 0:
        return 0.0
    fees_usd_day = fee_pct_day_of_tvl / 100 * tvl_usd
    pct_day = fees_usd_day * calibrated_fee_share(position_usd, tvl_usd, n_bins) / position_usd * 100
    return pct_day * fee_rate_realization(pct_day)


# What a position actually collects over its hold, against what the fee rate at entry implied. Measured on 481
# backtested trades (python -m app.backtest): the shortfall grows with the rate we enter on, because fee spikes
# mean-revert and because a hot pool leaves the range sooner. Medians by entry rate:
#   <10%/day 0.51x, 10-25% 0.46x, 25-50% 0.32x, >=50% 0.25x
# A power law fits those four points to within a few percent. Without this the gate judges entries on a fee level
# that typically never arrives: expected fees ran 2.4x the fees the same trades went on to collect.
FEE_REALIZATION_SCALE = 0.78
FEE_REALIZATION_EXP = -0.263


def fee_rate_realization(fee_pct_day: float) -> float:
    """Share of the entry fee rate a position collects over its hold (1.0 for calm pools, ~0.25 for hot ones)."""
    if fee_pct_day <= 0:
        return 1.0
    return min(1.0, FEE_REALIZATION_SCALE * fee_pct_day**FEE_REALIZATION_EXP)


def bin_array_index(bin_id: int) -> int:
    """Same as the SDK's binIdToBinArrayIndex (floor division, correct for negative ids)."""
    return bin_id // BINS_PER_BIN_ARRAY


def new_bin_arrays(depth: Depth, lower_offset: int, upper_offset: int) -> int | None:
    """Bin arrays a range [active+lower, active+upper] would have to create, or None when the range reaches
    arrays that were not scanned (unknown)."""
    lo = bin_array_index(depth.active_id + lower_offset)
    hi = bin_array_index(depth.active_id + upper_offset)
    if lo < depth.array_lo or hi > depth.array_hi:
        return None
    return sum(1 for i in range(lo, hi + 1) if i not in depth.initialized)
