"""Fee share from on-chain bin liquidity.

DLMM fees go only to liquidity in the bins that swaps cross, so "your share of fees" is your liquidity per
bin against the pool's liquidity per bin *around the active bin*, not your size against the whole TVL. A
pool whose TVL sits far from price pays in-range LPs much more than fee/TVL suggests; one crowded at the
active bin pays much less.

The ingestor writes `bins:latest` (see ingestor/src/bins.ts): per pool, non-empty bins as offsets from the
active bin with liquidity valued in token Y, plus which bin arrays exist (new ones cost non-refundable rent).
"""

import math
from dataclasses import dataclass
from typing import Any

BINS_PER_BIN_ARRAY = 70  # SDK MAX_BIN_ARRAY_SIZE
MAX_WINDOW_BINS = 35
DEPTH_MAX_AGE_MS = 15 * 60 * 1000

# Guards against attributing a pool's whole fee income to thin liquidity near the price. Paper trading once
# credited a $30 position with 46% of a pool's fees (36% of capital in 50 minutes): the price sat still next to
# $3.5/bin of liquidity while Meteora's rolling 1h fees ($89) came from trades an hour earlier, elsewhere.
# Liquidity near the price turns over at most this many times per hour; volume beyond it happened elsewhere.
MAX_WINDOW_TURNOVER_PER_HOUR = 24.0
# A position's share of fees is at most this multiple of its share of TVL. Concentrated liquidity near the price
# does earn more than the pool average (live pools showed 4-11x), but not orders of magnitude more.
MAX_DEPTH_BOOST = 10.0


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


def fee_share(position_per_bin_y: float, pool_per_bin_y: float) -> float:
    """Fraction of the window's fees earned by a position holding `position_per_bin_y` in each bin."""
    if position_per_bin_y <= 0:
        return 0.0
    return position_per_bin_y / (pool_per_bin_y + position_per_bin_y)


def guarded_fee_share(
    position_per_bin: float,
    pool_per_bin: float,
    window: int,
    position_value: float,
    tvl: float,
    volume_per_hour: float | None,
) -> float:
    """Share of the pool's fees a position earns, from bin depth but bounded (all amounts in one unit).

    1. Per-bin share: position_per_bin / (pool_per_bin + position_per_bin).
    2. Only the part of the pool's volume that liquidity near the price could have absorbed counts:
       min(1, MAX_WINDOW_TURNOVER_PER_HOUR x window liquidity / hourly volume).
    3. At most MAX_DEPTH_BOOST times the plain TVL share, position_value / (tvl + position_value).
    """
    if position_per_bin <= 0 or position_value <= 0:
        return 0.0
    share = fee_share(position_per_bin, pool_per_bin)
    if volume_per_hour and volume_per_hour > 0:
        window_liquidity = (pool_per_bin + position_per_bin) * (2 * max(window, 0) + 1)
        share *= min(1.0, MAX_WINDOW_TURNOVER_PER_HOUR * window_liquidity / volume_per_hour)
    if tvl > 0:
        share = min(share, MAX_DEPTH_BOOST * position_value / (tvl + position_value))
    return share


def fee_for_position_pct_day(
    fee_pct_day_of_tvl: float,
    tvl_usd: float,
    position_usd: float,
    n_bins: int,
    pool_per_bin_usd: float,
    window: int = 1,
    volume_per_hour_usd: float | None = None,
) -> float:
    """Daily fees for a position spread uniformly over `n_bins`, as % of the position.

    Pool fees per day in USD are fee/TVL x TVL; the position earns guarded_fee_share of them. With n_bins larger
    than the window the per-bin size, and so the share, shrinks: that is the real cost of a wide range.
    """
    if position_usd <= 0 or tvl_usd <= 0 or n_bins <= 0:
        return 0.0
    fees_usd_day = fee_pct_day_of_tvl / 100 * tvl_usd
    share = guarded_fee_share(
        position_usd / n_bins, pool_per_bin_usd, window, position_usd, tvl_usd, volume_per_hour_usd
    )
    return fees_usd_day * share / position_usd * 100


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
