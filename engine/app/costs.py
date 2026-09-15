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


def swap_cost_fraction(pool: dict[str, Any], swap_usd: float, model: CostModel) -> float:
    """Pool swap fee (base + dynamic) plus a price-impact estimate, as a fraction of the swapped value."""
    fee = ((pool.get("base_fee_pct") or 0.0) + (pool.get("dynamic_fee_pct") or 0.0)) / 100
    tvl = pool.get("tvl") or 0.0
    impact = min(model.max_impact, swap_usd / tvl * model.impact_multiplier) if tvl > 0 else model.max_impact
    return fee + impact


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
    """Cost in token Y to close all positions and swap the base tokens held at `price` back to token Y."""
    if not model.enabled:
        return 0.0
    base_y = lp.base_value(price)
    swap = base_y * swap_cost_fraction(pool, base_y * y_usd, model)
    return swap + positions * model.txs_close_per_position * model.tx_cost_sol * sol_to_y


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
