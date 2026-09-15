"""LP study, step 2: realized fees of real Meteora LP positions vs the fee model, to recalibrate app.depth.

Step 1 (`npm run lp-owners -- --out FILE` in ingestor/) lists wallets holding positions in sampled pools. This
fetches their positions from Meteora's PnL API and compares fees per capital-day with the TVL-share model:

    uv run python -m app.lp_study --owners FILE [--wallets 20] [--days 7]

Open positions count claimed + unclaimed fees; closed positions have all fees claimed. Positions under $20, younger
than 2h or older than `--days` are skipped. The model uses each pool's current 24h fees, so old positions compare
against today's activity: read the ratios as a calibration, not per-position truth.
"""

import argparse
import json
import random
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any

from .depth import NARROW_RANGE_BINS, REALIZATION_NARROW, REALIZATION_WIDE

PNL_URL = "https://dlmm.datapi.meteora.ag/positions/{pool}/pnl?user={user}&status={status}&pageSize=50&page=1"
HEADERS = {"User-Agent": "quant-lp-study/0.1", "Accept": "application/json"}
MIN_DEPOSIT_USD = 20.0
MIN_AGE_HOURS = 2.0


@dataclass(frozen=True)
class Record:
    pool: str
    status: str
    deposit_usd: float
    fees_usd: float
    age_hours: float
    width_bins: int
    tvl_model_pct_day: float  # pool fees/day x deposit / (TVL + deposit), as % of deposit

    @property
    def capital_days(self) -> float:
        return self.deposit_usd * self.age_hours / 24


def _num(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _usd(block: dict[str, Any] | None) -> float:
    if not block:
        return 0.0
    total = block.get("total") or {}
    if "usd" in total:
        return _num(total["usd"])
    return sum(_num((block.get(side) or {}).get("usd")) for side in ("tokenX", "tokenY"))


def position_record(pos: dict[str, Any], pool: dict[str, Any], now_s: float, max_days: float) -> Record | None:
    """One API position as a study record, or None when it is too small, too young or too old."""
    deposit = _usd(pos.get("allTimeDeposits"))
    fees = _usd(pos.get("allTimeFees"))
    status = "closed" if pos.get("isClosed") or pos.get("closedAt") else "open"
    if status == "open":
        unrealized = pos.get("unrealizedPnl") or {}
        fees += _num((unrealized.get("unclaimedFeeTokenX") or {}).get("usd"))
        fees += _num((unrealized.get("unclaimedFeeTokenY") or {}).get("usd"))
    created = _num(pos.get("createdAt"))
    end = _num(pos.get("closedAt")) or now_s
    age_hours = (end - created) / 3600
    width = int(_num(pos.get("upperBinId")) - _num(pos.get("lowerBinId")) + 1)
    tvl, fees_day = pool.get("tvl") or 0.0, pool.get("fees_24h") or 0.0
    if (deposit < MIN_DEPOSIT_USD or age_hours < MIN_AGE_HOURS or age_hours > max_days * 24
            or now_s - created > max_days * 86400 or width <= 0 or tvl <= 0):
        return None
    return Record(pool["name"], status, deposit, fees, age_hours, width, fees_day / (tvl + deposit) * 100)


def realization(records: list[Record]) -> float | None:
    """Capital-and-time weighted realized fees / TVL-model fees."""
    model = sum(r.tvl_model_pct_day / 100 * r.capital_days for r in records)
    return sum(r.fees_usd for r in records) / model if model > 0 else None


def _get(url: str) -> dict[str, Any] | None:
    for attempt in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=20) as res:
                return json.load(res)
        except urllib.error.HTTPError as err:
            if err.code == 429:
                time.sleep(5 * (attempt + 1))
                continue
            return None
        except (urllib.error.URLError, TimeoutError, ValueError):
            time.sleep(1)
    return None


def collect(owners_file: dict[str, Any], wallets: int, max_days: float, seed: int = 7) -> list[Record]:
    rng = random.Random(seed)
    now_s = time.time()
    records: list[Record] = []
    for pool in owners_file["pools"]:
        sample = list(owners_file["owners"].get(pool["address"], []))
        rng.shuffle(sample)
        for user in sample[:wallets]:
            for status in ("open", "closed"):
                body = _get(PNL_URL.format(pool=pool["address"], user=user, status=status))
                for pos in (body or {}).get("positions") or []:
                    rec = position_record(pos, pool, now_s, max_days)
                    if rec:
                        records.append(rec)
                time.sleep(0.15)
    return records


def report(records: list[Record]) -> dict[str, Any]:
    narrow = [r for r in records if r.width_bins <= NARROW_RANGE_BINS]
    wide = [r for r in records if r.width_bins > NARROW_RANGE_BINS]
    groups = {
        "all": records,
        "closed": [r for r in records if r.status == "closed"],
        "open": [r for r in records if r.status == "open"],
        f"narrow (<= {NARROW_RANGE_BINS} bins)": narrow,
        f"wide (> {NARROW_RANGE_BINS} bins)": wide,
    }
    out = {name: {"positions": len(rs), "realization": realization(rs)} for name, rs in groups.items()}
    out["per_pool"] = {
        pool: {"positions": len(rs), "realization": realization(rs)}
        for pool in sorted({r.pool for r in records})
        for rs in [[r for r in records if r.pool == pool]]
    }
    out["current_factors"] = {"narrow": REALIZATION_NARROW, "wide": REALIZATION_WIDE}
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description="Realized LP fees vs the TVL-share fee model")
    parser.add_argument("--owners", required=True, help="JSON from `npm run lp-owners` (ingestor)")
    parser.add_argument("--wallets", type=int, default=20, help="wallets sampled per pool")
    parser.add_argument("--days", type=float, default=7.0, help="max position age and recency, days")
    args = parser.parse_args()
    with open(args.owners) as fh:
        owners_file = json.load(fh)
    result = report(collect(owners_file, args.wallets, args.days))
    for name, group in result.items():
        if name in ("per_pool", "current_factors"):
            continue
        ratio = group["realization"]
        print(f"{name:24} positions {group['positions']:4}  realized / TVL model {ratio:.2f}" if ratio is not None
              else f"{name:24} positions {group['positions']:4}  -")
    print("\nper pool:")
    for pool, group in result["per_pool"].items():
        ratio = group["realization"]
        print(f"  {pool[:18]:18} positions {group['positions']:4}  {ratio:.2f}" if ratio is not None else f"  {pool[:18]:18} -")
    print(f"\ncurrent factors in app.depth: {result['current_factors']}")


if __name__ == "__main__":
    main()
