"""v2 heuristic pool score (0-100). Transparent on purpose; tune weights with app.backtest.

Opportunity (70):
  fee        35  expected daily fee/TVL for *your* position: recent-weighted, diluted by your size
  momentum   10  last-hour fee rate vs 24h average (catches pools whose activity already faded)
  liquidity  15  TVL depth, log scale: $10k -> 0, $1M -> full
  turnover    5  volume / TVL
  regime      5  sideways markets suit LP best (from ADX / Choppiness on 30m candles)
Safety (30): penalties for token red flags (incl. RugCheck) and market risk (dump/pump, downtrend,
extreme volatility, sell pressure, deep drawdown).
"""

import math
from typing import Any

from .depth import realization_factor

QUOTE_MINTS = {
    "So11111111111111111111111111111111111111112",  # SOL
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",  # USDC
    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",  # USDT
}

# Flags severe enough that the dashboard hides them by default and plans say "avoid".
RISKY_FLAGS = {"rugged", "mint_authority", "freeze_authority", "rugcheck_danger", "dumping", "pumping", "tvl_suspect"}

PUMP_PCT_1H = 30.0  # LPs entering a vertical pump end up holding the token at the top
DUMP_PCT_1H = -15.0
EXTREME_ATR_PCT = 8.0  # 30m ATR this large means range and IL are hard to control

# RugCheck risks already scored by dedicated checks (or irrelevant to DLMM positions),
# excluded from the generic "danger" penalty so nothing is penalized twice.
COVERED_RISKS = {
    "Mint Authority still enabled",
    "Freeze Authority still enabled",
    "Top 10 holders high ownership",
    "Single holder ownership",
    "High ownership",
    "High holder concentration",
    "Large Amount of LP Unlocked",  # about AMM LP tokens, not DLMM positions
}

# Verified tokens this large are usually bridged/wrapped assets or issuer-managed tokens
# (cbBTC, WBTC, tokenized stocks) where mint/freeze control and custody concentration are expected.
ISSUER_MIN_MARKET_CAP = 50_000_000

# Flags derived from price action / flow (recomputed per entry in backtests), with their safety penalty.
MARKET_PENALTIES = {
    "dumping": 10.0,
    "pumping": 10.0,
    "strong_downtrend": 8.0,
    "extreme_volatility": 5.0,
    "sell_pressure": 5.0,
    "deep_drawdown": 5.0,
}
MARKET_INFO_FLAGS = {"sideways", "uptrend", "bb_squeeze", "high_volatility", "fading_volume"}

REGIME_POINTS = {"ranging": 5.0, "mixed": 2.5, "trending_up": 1.0, "trending_down": 0.0}

# GMGN insider/dev signals (token-level safety penalties). Thresholds are first guesses to validate once
# token_insight_snapshots has a few weeks of history.
SERIAL_DEV_LAUNCHES = 20
DEV_HOLD_PCT = 5.0
BUNDLER_HEAVY_PCT = 15.0
SNIPER_HEAVY_PCT = 15.0
SMART_EXIT_MIN_WALLETS = 3
PAID_HYPE_WINDOW_MS = 24 * 3_600_000
INSIGHT_PENALTIES = {
    "bundler_heavy": 8.0,
    "dev_holds": 5.0,
    "sniper_heavy": 5.0,
    "smart_money_exit": 5.0,
    "serial_dev": 3.0,
}

# Jupiter organic score (0-100). On the screener's tokens: "high" 80-99, "medium" 38-80, "low" is 0 (no organic
# activity detected, e.g. wash-traded or bot-driven). The organic *volume* share is small even for healthy tokens
# (median ~9%), so it is shown but not penalized.
ORGANIC_LOW_SCORE = 40.0
ORGANIC_WEAK_SCORE = 60.0
BOT_HOLDERS_HEAVY_PCT = 10.0  # screener p90 was ~13%
ORGANIC_PENALTIES = {"organic_low": 8.0, "bot_holders_heavy": 5.0}

# pump.fun signals, all informational until validated on LP outcomes. "pump_banned" is pump.fun front-end moderation
# (the coin is hidden on pump.fun), not an on-chain risk: CATE, a $65M token with deep Meteora pools, is flagged. A token below this share of its
# all-time-high market cap is in post-peak decay; a Meteora pool holding less than this share of the token's
# Meteora + PumpSwap liquidity competes with a deeper venue for the same flow.
ATH_DRAWDOWN_SHARE = 0.3
MIN_METEORA_LIQUIDITY_SHARE = 0.3


def pump_flags(pump: dict[str, Any] | None, pool_tvl: float) -> list[str]:
    if not pump or not pump.get("found"):
        return []
    flags: list[str] = []
    if pump.get("is_banned"):
        flags.append("pump_banned")
    ath, mcap = pump.get("ath_market_cap_usd") or 0.0, pump.get("usd_market_cap") or 0.0
    if ath > 0 and mcap > 0 and mcap < ATH_DRAWDOWN_SHARE * ath:
        flags.append("ath_drawdown")
    elsewhere = pump.get("pumpswap_liquidity_usd") or 0.0
    if elsewhere > 0 and pool_tvl > 0 and pool_tvl / (pool_tvl + elsewhere) < MIN_METEORA_LIQUIDITY_SHARE:
        flags.append("liquidity_elsewhere")
    return flags


# Reported TVL sanity. A pool claiming more than this multiple of its token's liquidity across all DEXes (Jupiter)
# is checked against the liquidity actually read from its bins on-chain; below MIN_SCANNED_TVL_SHARE of the claimed
# TVL, the figure is treated as wrong (ANTFUN-USDT reported $64.7M TVL: 4.2x Jupiter liquidity, 9% found on-chain).
# Tokenized stocks like MU-USDC also exceed the Jupiter multiple but their bins hold the TVL, so they pass.
TVL_VS_TOKEN_LIQUIDITY_MAX = 2.0
MIN_SCANNED_TVL_SHARE = 0.2

# Dynamic fee at least this share of the base fee: price is crossing bins fast, so each swap pays more.
# An opportunity for fees and a warning for IL at the same time, hence informational only.
FEE_SPIKE_RATIO = 0.5

HOUR_MS = 3_600_000


def base_token(pool: dict[str, Any]) -> dict[str, Any]:
    """The non-quote side of the pair (the memecoin, usually)."""
    tx, ty = pool["token_x"], pool["token_y"]
    if tx["mint"] in QUOTE_MINTS and ty["mint"] not in QUOTE_MINTS:
        return ty
    return tx


def _log_scaled(value: float, saturate_at: float) -> float:
    if value <= 0:
        return 0.0
    return min(1.0, math.log10(1 + value) / math.log10(1 + saturate_at))


def _clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


# A pool whose reported TVL has collapsed makes fees/TVL explode: CHIP-USDC reported $0.000377 of TVL against
# $1,126 of 24h fees, i.e. 298,507,864%/day, and paper trading booked $3.4M of fees on a $100 position from it.
# Volume/TVL above this means the reported TVL is stale or drained, so the fee ratio is computed against a floor
# instead. Same guard, same constant, as the backtest's tvl_at().
MAX_DAILY_TURNOVER = 20.0


def effective_tvl(pool: dict[str, Any]) -> float:
    """Reported TVL, floored by 24h volume / MAX_DAILY_TURNOVER so a drained pool cannot imply absurd fee rates."""
    tvl = pool.get("tvl") or 0.0
    volume_24h = (pool.get("volume") or {}).get("24h") or 0.0
    return max(tvl, volume_24h / MAX_DAILY_TURNOVER) if volume_24h > 0 else tvl


def fee_tvl_pct_sane(pool: dict[str, Any]) -> dict[str, float]:
    """The pool's fee/TVL percentages recomputed against effective_tvl. The upstream `fee_tvl_pct` divides by the
    reported TVL, which goes to zero on dead pools."""
    tvl = effective_tvl(pool)
    if tvl <= 0:
        return {}
    return {window: (fees or 0.0) / tvl * 100 for window, fees in (pool.get("fees") or {}).items()}


def expected_fee_pct_day(fee_tvl_pct: dict[str, float]) -> float:
    """Daily fee/TVL estimate weighted toward recent windows (24h 20%, 4h 40%, 1h 40%)."""
    return (
        0.2 * (fee_tvl_pct.get("24h") or 0.0)
        + 0.4 * (fee_tvl_pct.get("4h") or 0.0) * 6
        + 0.4 * (fee_tvl_pct.get("1h") or 0.0) * 24
    )


def diluted_fee_pct(fee_pct: float, tvl: float, position_usd: float) -> float:
    """Adding your own liquidity shrinks everyone's share of the same fees."""
    return fee_pct * tvl / (tvl + position_usd) if tvl > 0 else 0.0


def market_flags(market: dict[str, Any] | None, change_pct_1h: float | None) -> list[str]:
    """Price-action and flow flags; penalties for the risky ones live in MARKET_PENALTIES."""
    flags: list[str] = []
    m = market or {}
    regime = m.get("regime")
    if change_pct_1h is not None and change_pct_1h <= DUMP_PCT_1H:
        flags.append("dumping")
    if change_pct_1h is not None and change_pct_1h >= PUMP_PCT_1H:
        flags.append("pumping")
    if regime == "trending_down" and (m.get("adx") or 0) >= 30 and (m.get("ema_slope_pct") or 0) < 0:
        flags.append("strong_downtrend")
    if m.get("atr_pct") is not None and m["atr_pct"] >= EXTREME_ATR_PCT:
        flags.append("extreme_volatility")
    if m.get("sell_pressure"):
        flags.append("sell_pressure")
    if m.get("drawdown_pct") is not None and m["drawdown_pct"] <= -30:
        flags.append("deep_drawdown")
    if regime == "ranging":
        flags.append("sideways")
    elif regime == "trending_up":
        flags.append("uptrend")
    if m.get("bb_squeeze"):
        flags.append("bb_squeeze")
    return flags


def insight_flags(insights: dict[str, Any] | None, now_ms: int) -> list[str]:
    """Insider/dev flags from GMGN; penalties for the risky ones live in INSIGHT_PENALTIES."""
    if not insights:
        return []
    dev = insights.get("dev") or {}
    tags = insights.get("tags") or {}
    flags: list[str] = []
    if (dev.get("launches") or 0) >= SERIAL_DEV_LAUNCHES:
        flags.append("serial_dev")
    if (dev.get("hold_pct") or 0) >= DEV_HOLD_PCT:
        flags.append("dev_holds")
    if ((tags.get("bundler") or {}).get("holding_pct") or 0) >= BUNDLER_HEAVY_PCT:
        flags.append("bundler_heavy")
    if ((tags.get("sniper") or {}).get("holding_pct") or 0) >= SNIPER_HEAVY_PCT:
        flags.append("sniper_heavy")
    smart = tags.get("smart_degen") or {}
    if (smart.get("count") or 0) >= SMART_EXIT_MIN_WALLETS and (smart.get("netflow_usd") or 0) < 0:
        flags.append("smart_money_exit")
    promo = [t for t in (dev.get("boost_ts"), dev.get("ad_ts")) if t]
    if any(now_ms - t * 1000 <= PAID_HYPE_WINDOW_MS for t in promo):
        flags.append("paid_hype")
    return flags


def organic_flags(organic: dict[str, Any] | None) -> list[str]:
    """Jupiter organic-activity flags; penalties for the risky ones live in ORGANIC_PENALTIES."""
    if not organic:
        return []
    flags: list[str] = []
    score = organic.get("organic_score")
    if organic.get("organic_label") == "low" or (score is not None and score < ORGANIC_LOW_SCORE):
        flags.append("organic_low")
    elif score is not None and score < ORGANIC_WEAK_SCORE:
        flags.append("organic_weak")
    if (organic.get("bot_holders_pct") or 0) >= BOT_HOLDERS_HEAVY_PCT:
        flags.append("bot_holders_heavy")
    return flags


def tvl_flags(tvl: float, token_liquidity_usd: float | None, scanned_usd: float | None) -> list[str]:
    """"tvl_suspect" when the reported TVL is implausible and on-chain bins do not back it; "tvl_unverified" when it is
    implausible but no on-chain depth was read for the pool."""
    if not tvl or not token_liquidity_usd or tvl <= TVL_VS_TOKEN_LIQUIDITY_MAX * token_liquidity_usd:
        return []
    if scanned_usd is None:
        return ["tvl_unverified"]
    return ["tvl_suspect"] if scanned_usd < MIN_SCANNED_TVL_SHARE * tvl else []


def score_pool(
    pool: dict[str, Any],
    change_pct_1h: float | None,
    realized_vol_pct_1h: float | None,
    now_ms: int,
    security: dict[str, Any] | None,
    position_usd: float,
    market: dict[str, Any] | None = None,
    insights: dict[str, Any] | None = None,
    organic: dict[str, Any] | None = None,
    fee_bins: int | None = None,
    depth_scanned_usd: float | None = None,
    pump: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """`fee_bins`: range width the fee estimate assumes (the plan is built afterwards; the service re-estimates
    with the plan's own width). None = narrow-range realization."""
    tvl = pool["tvl"] or 0.0
    fees = pool["fee_tvl_pct"]
    fee_24h = fees.get("24h") or 0.0
    fee_1h_x24 = (fees.get("1h") or 0.0) * 24
    fee_expected = expected_fee_pct_day(fees)
    fee_for_position = diluted_fee_pct(fee_expected, tvl, position_usd) * (
        realization_factor(fee_bins) if fee_bins else 1.0
    )
    volume_tvl = pool["volume"]["24h"] / tvl if tvl > 0 else 0.0
    momentum = fee_1h_x24 / fee_24h if fee_24h > 0 else 0.0
    regime = (market or {}).get("regime")

    fee_score = 35 * _log_scaled(fee_for_position, 30)  # 30%/day saturates
    momentum_score = 10 * min(momentum, 2.0) / 2
    liquidity_score = 15 * _clamp(math.log10(tvl / 10_000) / 2, 0, 1) if tvl > 0 else 0.0
    turnover_score = 5 * _log_scaled(volume_tvl, 20)
    regime_score = REGIME_POINTS.get(regime, 2.5)

    base = base_token(pool)
    holders = base.get("holders") or 0
    market_cap = base.get("market_cap") or 0.0
    created = pool.get("pool_created_at")
    age_hours = (now_ms - created) / HOUR_MS if created else None

    safety = 30.0
    flags: list[str] = []

    def penalize(flag: str, points: float) -> None:
        nonlocal safety
        safety -= points
        flags.append(flag)

    issuer = bool(base.get("verified")) and market_cap >= ISSUER_MIN_MARKET_CAP
    has_freeze = bool((security or {}).get("freeze_authority")) or not base.get("freeze_disabled", False)
    has_mint = bool((security or {}).get("mint_authority"))
    if issuer and (has_mint or has_freeze):
        flags.append("issuer_controlled")

    rugged = False
    if security is None:
        penalize("security_pending", 5)
    else:
        rugged = bool(security.get("rugged"))
        if rugged:
            flags.append("rugged")
        if has_mint and not issuer:
            penalize("mint_authority", 15)
        top10 = security.get("top10_pct")
        if not issuer and top10 is not None and top10 >= 50:
            penalize("top_holders_50", 10)
        elif not issuer and top10 is not None and top10 >= 30:
            penalize("top_holders_30", 5)
        other_danger = [
            r for r in security.get("risks", [])
            if r.get("level") == "danger" and r.get("name") not in COVERED_RISKS
        ]
        if other_danger:
            penalize("rugcheck_danger", 10)

    if has_freeze and not issuer:
        penalize("freeze_authority", 15)
    # Large verified issuer tokens (wrapped/bridged) have custodial holders that look like insiders.
    for flag in insight_flags(None if issuer else insights, now_ms):
        if flag in INSIGHT_PENALTIES:
            penalize(flag, INSIGHT_PENALTIES[flag])
        else:
            flags.append(flag)
    # Issuer tokens (tokenized stocks, wrapped assets) trade through market makers that Jupiter scores as non-organic.
    for flag in organic_flags(None if issuer else organic):
        if flag in ORGANIC_PENALTIES:
            penalize(flag, ORGANIC_PENALTIES[flag])
        else:
            flags.append(flag)
    if holders < 1000:
        penalize("low_holders", 5)
    if market_cap < 1_000_000:
        penalize("low_mcap", 5)
    if age_hours is not None and age_hours < 6:
        penalize("new_pool", 5)
    for flag in market_flags(market, change_pct_1h):
        if flag in MARKET_PENALTIES:
            penalize(flag, MARKET_PENALTIES[flag])
        else:
            flags.append(flag)

    # Informational flags: shown in the UI, no direct penalty.
    if not base.get("verified", False):
        flags.append("unverified")
    if realized_vol_pct_1h is not None and realized_vol_pct_1h >= 20:
        flags.append("high_volatility")
    if tvl < 25_000:
        flags.append("thin_liquidity")
    flags.extend(tvl_flags(tvl, (organic or {}).get("liquidity_usd"), depth_scanned_usd))
    flags.extend(pump_flags(pump, tvl))
    if fee_24h > 0 and momentum < 0.25:
        flags.append("fading_volume")
    base_fee_pct = pool.get("base_fee_pct") or 0.0
    dynamic_fee_pct = pool.get("dynamic_fee_pct") or 0.0
    fee_multiple_now = (base_fee_pct + dynamic_fee_pct) / base_fee_pct if base_fee_pct > 0 else None
    if base_fee_pct > 0 and dynamic_fee_pct >= base_fee_pct * FEE_SPIKE_RATIO:
        flags.append("fee_spike")

    safety = 0.0 if rugged else max(safety, 0.0)
    score = fee_score + momentum_score + liquidity_score + turnover_score + regime_score + safety
    if rugged:
        score = min(score, 10.0)

    return {
        "score": round(score, 1),
        "safety": safety,
        "flags": flags,
        "regime": regime,
        "base_symbol": base.get("symbol"),
        "base_mint": base.get("mint"),
        "holders": holders,
        "market_cap": market_cap,
        "pool_age_hours": age_hours,
        "fee_tvl_pct_24h": fee_24h,
        "fee_tvl_pct_1h_x24": fee_1h_x24,
        "fee_expected_pct_day": fee_expected,
        "fee_for_position_pct_day": fee_for_position,
        "fee_multiple_now": fee_multiple_now,
        "volume_tvl_24h": volume_tvl,
    }
