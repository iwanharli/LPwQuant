"""Three risk tiers for LP candidates: low / medium / high.

Risk combines token safety, price volatility (30m ATR, or realized volatility), liquidity depth and trend.
Pools with severe flags get no tier at all (not recommended). The expected return comes from the fee
estimate; whether higher tiers really earn more is checked per tier in app.backtest / app.validation.
"""

EXCLUDE_FLAGS = {"rugged", "mint_authority", "freeze_authority", "rugcheck_danger", "dumping", "pumping", "tvl_suspect"}

LOW_MIN_SAFETY, LOW_MAX_VOL_PCT, LOW_MIN_TVL = 25.0, 2.0, 100_000.0
MEDIUM_MIN_SAFETY, MEDIUM_MAX_VOL_PCT, MEDIUM_MIN_TVL = 15.0, 5.0, 25_000.0

# 1h realized volatility is roughly this multiple of a 30m ATR-based move.
RV_TO_ATR = 0.7


def excluded_reason(flags: list[str], safety: float) -> str | None:
    severe = set(flags) & EXCLUDE_FLAGS
    if severe:
        return "Flag risiko berat: " + ", ".join(sorted(severe))
    if safety <= 5:
        return "Skor keamanan token terlalu rendah"
    return None


def volatility_pct(atr_pct: float | None, realized_vol_pct_1h: float | None) -> float | None:
    if atr_pct is not None:
        return atr_pct
    return realized_vol_pct_1h * RV_TO_ATR if realized_vol_pct_1h is not None else None


def classify_tier(
    *, safety: float, flags: list[str], tvl: float, vol_pct: float, regime: str | None
) -> tuple[str | None, str]:
    """(tier, reason). tier is None when the pool is excluded."""
    reason = excluded_reason(flags, safety)
    if reason:
        return None, reason
    flagset = set(flags)
    strong_downtrend = "strong_downtrend" in flagset

    if (
        safety >= LOW_MIN_SAFETY
        and vol_pct <= LOW_MAX_VOL_PCT
        and tvl >= LOW_MIN_TVL
        and regime != "trending_down"
        and not strong_downtrend
    ):
        return "low", "Token aman, volatilitas rendah, likuiditas dalam"
    if safety >= MEDIUM_MIN_SAFETY and vol_pct <= MEDIUM_MAX_VOL_PCT and tvl >= MEDIUM_MIN_TVL and not strong_downtrend:
        return "medium", "Keamanan dan likuiditas cukup, volatilitas sedang"

    reasons = []
    if safety < MEDIUM_MIN_SAFETY:
        reasons.append("keamanan token rendah")
    if vol_pct > MEDIUM_MAX_VOL_PCT:
        reasons.append("sangat volatil")
    if tvl < MEDIUM_MIN_TVL:
        reasons.append("TVL tipis")
    if strong_downtrend:
        reasons.append("tren turun kuat")
    return "high", "Risiko tinggi: " + (", ".join(reasons) if reasons else "kombinasi faktor")
