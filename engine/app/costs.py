"""Transaction, swap and rent costs of opening and closing a DLMM position, shared by paper trading and the
backtest so both judge a trade by the same money. Values are in the position's quote units (token Y in paper
trading, USD in the backtest: pass y_usd=1 and sol_to_y=SOL price)."""

import math
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .backtest import LpPosition

BINS_PER_BIN_ARRAY = 70  # SDK MAX_BIN_ARRAY_SIZE


@dataclass(frozen=True)
class CostModel:
    enabled: bool = True
    tx_cost_sol: float = 0.00015  # base fee (5,000 lamports) + priority fee, per transaction
    txs_open_per_position: int = 2  # initialize position + add liquidity
    txs_close_per_position: int = 2  # remove liquidity & claim + close position
    position_rent_sol: float = 0.05740608  # SDK POSITION_FEE, refunded on close
    bin_array_rent_sol: float = 0.07143744  # SDK BIN_ARRAY_FEE, not refunded
    new_bin_array_share: float = 0.0  # share of the range's bin arrays assumed uninitialized
    impact_multiplier: float = 1.0  # price impact = swap value / pool TVL * multiplier
    max_impact: float = 0.05
    # Share of the base tokens held at close that we swap back to the quote token (see exit_cost). Closing a DLMM
    # position does not swap by itself, but equity is measured in the quote token and the next position in another
    # pool must be funded from it, so the default charges the full swap. Lower it to model keeping the bag.
    exit_swap_share: float = 1.0


def swap_cost_fraction(pool: dict[str, Any], swap_usd: float, model: CostModel) -> float:
    """Pool swap fee (base + dynamic) plus a price-impact estimate, as a fraction of the swapped value.

    With on-chain bin depth (`depth_per_bin_usd` on the pool dict), impact follows the bins the swap crosses:
    it consumes `swap / depth_per_bin` bins, each moving the price by one bin step, so the average fill is about
    half of that move. Without depth it falls back to swap value over TVL.
    """
    fee = ((pool.get("base_fee_pct") or 0.0) + (pool.get("dynamic_fee_pct") or 0.0)) / 100
    depth_per_bin = pool.get("depth_per_bin_usd") or 0.0
    bin_step = pool.get("bin_step") or 0
    if depth_per_bin > 0 and bin_step > 0:
        bins_crossed = swap_usd / depth_per_bin
        impact = bins_crossed * (bin_step / 10_000) / 2 * model.impact_multiplier
    else:
        tvl = pool.get("tvl") or 0.0
        impact = swap_usd / tvl * model.impact_multiplier if tvl > 0 else model.max_impact
    return fee + min(model.max_impact, impact)


def entry_costs(
    lp: "LpPosition",
    positions: int,
    pool: dict[str, Any],
    y_usd: float,
    sol_to_y: float,
    model: CostModel,
    new_bin_arrays: int | None = None,
) -> tuple[float, float]:
    """(cost in token Y, refundable rent in SOL) to open the position from token Y. `new_bin_arrays` is the
    on-chain count of bin arrays the range must create; when unknown, `model.new_bin_array_share` is assumed."""
    if not model.enabled:
        return 0.0, 0.0
    capital_y = lp.v * (lp.a + lp.b + 1)
    swap_y = capital_y * (lp.b + 0.5) / (lp.a + lp.b + 1)  # base-token share: bins above + half the active bin
    swap = swap_y * swap_cost_fraction(pool, swap_y * y_usd, model)
    txs = positions * model.txs_open_per_position * model.tx_cost_sol * sol_to_y
    if new_bin_arrays is None:
        new_bin_arrays_est = model.new_bin_array_share * math.ceil((lp.a + lp.b + 1) / BINS_PER_BIN_ARRAY)
    else:
        new_bin_arrays_est = float(new_bin_arrays)
    bin_array_rent = new_bin_arrays_est * model.bin_array_rent_sol * sol_to_y
    return swap + txs + bin_array_rent, positions * model.position_rent_sol


def exit_cost(
    lp: "LpPosition", price: float, positions: int, pool: dict[str, Any], y_usd: float, sol_to_y: float, model: CostModel
) -> float:
    """Cost in token Y to close all positions and swap the base tokens held at `price` back to token Y.

    Closing itself never swaps: the bins are withdrawn as whatever mix of base and quote they hold (only an
    explicit zap out swaps). The swap is charged anyway because the round trip this model prices starts and ends
    in the quote token -- redeploying into another pool has to sell the base tokens. What the model does assume is
    that the sale happens immediately, at the close price; `model.exit_swap_share` makes that assumption explicit
    and testable (1.0 = sell everything at close, 0.0 = keep the whole bag and pay nothing here).
    """
    if not model.enabled:
        return 0.0
    base_y = lp.base_value(price) * model.exit_swap_share
    swap = base_y * swap_cost_fraction(pool, base_y * y_usd, model)
    return swap + positions * model.txs_close_per_position * model.tx_cost_sol * sol_to_y


def fixed_cost_usd(
    positions: int, n_bins: int, sol_usd: float, model: CostModel, new_bin_arrays: int | None = None
) -> float:
    """Size-independent part of the round trip in USD: transactions and non-refundable bin array rent. Swap fees
    and price impact scale with size; these do not, which is why small positions pay a larger cost share."""
    if not model.enabled or sol_usd <= 0:
        return 0.0
    txs = positions * (model.txs_open_per_position + model.txs_close_per_position) * model.tx_cost_sol
    if new_bin_arrays is None:
        arrays = model.new_bin_array_share * math.ceil(n_bins / BINS_PER_BIN_ARRAY)
    else:
        arrays = float(new_bin_arrays)
    return (txs + arrays * model.bin_array_rent_sol) * sol_usd


def resized_cost_pct(cost_pct: float, fixed_usd: float, base_size_usd: float, size_usd: float) -> float:
    """Round-trip cost % for `size_usd`, from the cost % measured at `base_size_usd` and its fixed USD part."""
    if base_size_usd <= 0 or size_usd <= 0:
        return cost_pct
    variable_pct = max(0.0, cost_pct - fixed_usd / base_size_usd * 100)
    return variable_pct + fixed_usd / size_usd * 100


def round_trip_cost_pct(
    lp: "LpPosition",
    positions: int,
    pool: dict[str, Any],
    y_usd: float,
    sol_to_y: float,
    model: CostModel,
    new_bin_arrays: int | None = None,
) -> float:
    """Entry plus exit-at-entry-price cost, as % of capital. Rent is refunded, so it is not a cost."""
    capital = lp.v * (lp.a + lp.b + 1)
    if capital <= 0 or not model.enabled:
        return 0.0
    entry, _ = entry_costs(lp, positions, pool, y_usd, sol_to_y, model, new_bin_arrays)
    return (entry + exit_cost(lp, lp.p0, positions, pool, y_usd, sol_to_y, model)) / capital * 100
