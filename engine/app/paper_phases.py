"""Phases of the paper tests: a strategy's rules change only at the start of a new phase, and each phase is judged on
its own trades, from zero, so the old rules and the new can be compared side by side.

PHASES is the source of truth: the current phase number of every strategy and what changed in it. The first time the
engine runs with a higher number, the phase's start is written to paper_phases; trades opened from then on belong to
it. Positions still open from the previous phase keep counting to that phase, under whatever rules now run them.
Nothing is deleted: every earlier phase stays in the database and on the overview.
"""

from datetime import datetime
from typing import Any

# key -> {phase number: what that phase is}. Keys match paper_overview's strategy keys.
PHASES: dict[str, dict[int, str]] = {
    "bronto": {
        1: "Range lebar 70 bin di tengah harga, tanpa stop-loss; keluar setelah 12 jam begitu untung, saat likuiditas "
           "ditarik, atau setelah 72 jam.",
        2: "Sama, plus keluar begitu harga jatuh di bawah range (fase 1: 64 posisi ikut tenggelam sampai likuiditas "
           "ditarik, −$2.863, harga −72..−82%).",
        3: "Sama, plus token yang baru keluar di bawah range tidak dimasuki lagi selama 24 jam. Fase 2: DOPE dua "
           "kali keluar di bawah range dalam 2 jam (-$37) lalu dibuka lagi.",
    },
    "lp:satu_sisi": {
        1: "SOL/USDC satu sisi di bawah harga, pool tenang (ATR 30m <=2%), fee harus 2x biaya; harga dicek tiap 60 detik.",
        2: "Sama, tapi stop-loss dicek di setiap harga baru (±10 detik), bukan tiap 60 detik. Fase 1: 3 stop-loss "
           "yang seharusnya di -5,5..-10% tembus ke -11..-13% (-$36), sementara 81 posisi lainnya +$39.",
    },
    "copy": {
        1: "Meniru setiap posisi baru 5 wallet LP teratas, $100 per posisi.",
        2: "Hanya wallet yang tiruannya tidak rugi dan posisinya bertahan ≥2 jam (median 30 tiruan terakhir); wallet "
           "baru (<10 tiruan) tetap dicoba. Fase 1: untung +$659 sebelum biaya, tapi biaya $1.270 dari posisi "
           "pendek wallet yang sangat sering buka-tutup.",
        3: "Sama, tapi wallet baru sudah dinilai setelah 5 tiruan (bukan 10), dan tiruan ditutup kalau sudah -15%. "
           "Fase 2: wallet baru dengan posisi 0,3-1 jam tetap ditiru 10 kali; satu tiruan jatuh -31% (SEALS).",
    },
    "panda": {
        1: "SOL satu sisi sampai −90% di bawah harga; keluar di pantulan pertama (RSI(2) + Bollinger/MACD).",
        2: "Range sampai −40%; keluar kalau harga tembus bawah range; keluar di pantulan hanya kalau sudah untung "
           "(rencana 26 Sep). Fase 1: 8 posisi jatuh −55..−94% dan dijual di pantulan kecil, −$116.",
    },
    "lp:satu_sisi_sering": {
        1: "Seperti Ankylosaurus, tapi fee cukup 1x biaya.",
        2: "Sama, tapi saat harga naik melewati range tunggu 60 menit (bukan 20) sebelum keluar. Fase 1: 43 posisi "
           "keluar di atas range setelah ±1 jam dengan fee hanya 0,12%.",
    },
    "sol_grid": {
        1: "5 order beli 1% di bawah harga, jual 1% di atasnya, tanpa stop.",
        2: "Sama, tapi tidak membeli baru saat SOL di bawah rata-rata 7 hari (fase 1 terus membeli saat SOL turun).",
    },
    "sol_grid_0.5": {
        1: "5 order beli 0,5% di bawah harga, jual 0,5% di atasnya, tanpa stop.",
        2: "Sama, tapi tidak membeli baru saat SOL di bawah rata-rata 7 hari.",
    },
}

_starts: dict[str, list[tuple[int, datetime]]] = {}


def current(key: str) -> int:
    return max(PHASES.get(key, {1: ""}))


async def ensure(db) -> None:
    """Record the start of every strategy's current phase (once), and load all phase starts."""
    for key, phases in PHASES.items():
        await db.execute(
            "insert into paper_phases (strategy, phase, note) values ($1, $2, $3) on conflict do nothing",
            key, max(phases), phases[max(phases)],
        )
    _starts.clear()
    for r in await db.fetch("select strategy, phase, started_at from paper_phases order by strategy, phase"):
        _starts.setdefault(r["strategy"], []).append((r["phase"], r["started_at"]))


def windows(key: str) -> list[tuple[int, datetime | None, datetime | None]]:
    """(phase, from, until) for every phase of a strategy, oldest first. Phase 1 has no start: it holds everything
    before phase 2. The current phase has no end."""
    recorded = {p: t for p, t in _starts.get(key, [])}
    numbers = sorted(set(PHASES.get(key, {1: ""})) | set(recorded))
    out = []
    for i, n in enumerate(numbers):
        start = recorded.get(n) if n > 1 else None
        nxt = recorded.get(numbers[i + 1]) if i + 1 < len(numbers) else None
        out.append((n, start, nxt))
    return out


def since(key: str) -> datetime | None:
    """Start of the strategy's current phase (None while it is still phase 1)."""
    return windows(key)[-1][1]


def info(key: str) -> list[dict[str, Any]]:
    ms = lambda t: int(t.timestamp() * 1000) if t else None  # noqa: E731
    return [{"phase": n, "started_at": ms(a), "ended_at": ms(b), "note": PHASES.get(key, {}).get(n, "")}
            for n, a, b in windows(key)]
