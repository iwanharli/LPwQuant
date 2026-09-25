"""Telegram alerts for the wallet's open LP positions: out of range, back in range, profit reached, liquidity pulled.

Every EVERY_S the wallet's open positions are read (Meteora portfolio, cached) and compared with what was already
announced. Only transitions are sent. What was sent is kept in alerts_sent (kind + position address), so a restart
does not repeat itself; "out of range" is removed again when the price comes back, so it can fire a second time.
"""

import asyncio
import logging
from typing import Any, Callable

from . import config, portfolio
from .alerts import _esc, _post

log = logging.getLogger("position_alerts")

EVERY_S = 60
PROFIT_PCT = 3.0  # Meteora PnL at which closing is worth a look (the history showed +3-5% as the safe exit)
PULLED_FRAC = 0.4  # pool TVL under 40% of the highest seen while the position was open


class PositionAlerts:
    def __init__(self, db, rows: Callable[[], dict[str, dict[str, Any]]]) -> None:
        self.db = db
        self.rows = rows
        self.peak_tvl: dict[str, float] = {}

    async def run(self) -> None:
        if not (config.TELEGRAM_BOT_TOKEN and config.TELEGRAM_CHAT_ID and "position" in config.ALERT_KINDS):
            log.info("position alerts off (add 'position' to ALERT_KINDS)")
            return
        while True:
            try:
                for r in await self.db.fetch("select address from portfolio_wallets"):
                    await self._check(r["address"])
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("position alerts round failed")
            await asyncio.sleep(EVERY_S)

    async def _sent(self) -> set[tuple[str, str]]:
        rows = await self.db.fetch("select kind, address from alerts_sent where kind like 'pos_%'")
        return {(r["kind"], r["address"]) for r in rows}

    async def _mark(self, kind: str, position: str) -> None:
        await self.db.execute(
            "insert into alerts_sent (kind, address, ts) values ($1, $2, now()) on conflict do nothing", kind, position)

    async def _unmark(self, kind: str, position: str) -> None:
        await self.db.execute("delete from alerts_sent where kind = $1 and address = $2", kind, position)

    async def _send(self, text: str) -> None:
        await asyncio.to_thread(_post, config.TELEGRAM_BOT_TOKEN, config.TELEGRAM_CHAT_ID, text)

    async def _check(self, wallet: str) -> None:
        pf = await portfolio.fetch_portfolio(self.db, wallet)
        sent = await self._sent()
        rows = self.rows()
        open_now: set[str] = set()
        for pool in pf.get("pools") or []:
            name = f"{pool.get('token_x') or '?'}/{pool.get('token_y') or '?'}"
            link = f"https://lp.kecup.in/pool/{pool['address']}"
            tvl = (rows.get(pool["address"]) or {}).get("tvl")
            for q in pool.get("positions") or []:
                pos = q["address"]
                open_now.add(pos)
                head = f"<b>{_esc(name)}</b> · PnL {q['pnl_pct']:+.1f}% ({q['pnl_usd']:+.2f} USD)"

                if q.get("out_of_range") and ("pos_range", pos) not in sent:
                    below = (q.get("active_price") or 0) < (q.get("min_price") or 0)
                    why = ("Harga turun di bawah range: posisimu kini penuh token, tidak dapat fee."
                           if below else "Harga naik di atas range: posisimu kini penuh SOL/USDC, tidak dapat fee.")
                    await self._send(f"📤 <b>Posisi keluar range</b>\n{head}\n{why}\n{link}")
                    await self._mark("pos_range", pos)
                elif not q.get("out_of_range") and ("pos_range", pos) in sent:
                    await self._send(f"📥 <b>Posisi kembali masuk range</b>\n{head}\nFee berjalan lagi.\n{link}")
                    await self._unmark("pos_range", pos)

                if (q.get("pnl_pct") or 0) >= PROFIT_PCT and ("pos_profit", pos) not in sent:
                    await self._send(
                        f"💰 <b>Posisi untung ≥{PROFIT_PCT:g}%</b>\n{head}\n"
                        "Riwayatmu menunjukkan +3–5% adalah titik keluar yang aman. Pertimbangkan tutup dan jual.\n" + link)
                    await self._mark("pos_profit", pos)

                if tvl:
                    peak = max(self.peak_tvl.get(pos, 0.0), float(tvl))
                    self.peak_tvl[pos] = peak
                    if tvl < peak * PULLED_FRAC and ("pos_pulled", pos) not in sent:
                        await self._send(
                            f"🚨 <b>Likuiditas pool dicabut</b>\n{head}\n"
                            f"TVL pool turun dari ${peak:,.0f} ke ${tvl:,.0f}. Bisa jadi tanda rug; cek sekarang.\n{link}")
                        await self._mark("pos_pulled", pos)
        # Closed positions: forget their peaks; their sent rows stay and do no harm.
        for pos in [p for p in self.peak_tvl if p not in open_now]:
            self.peak_tvl.pop(pos, None)
