"""Readable names and explanations for the screener's pool flags, for Telegram.

Mirrors FLAG_META in dashboard/app/lib/flags.ts; keep the two in sync. Telegram messages show the label with a
severity dot instead of the raw snake_case key, and the bot's "Info flag" button and /flags command read the
explanations from here.
"""

from typing import NamedTuple


class Flag(NamedTuple):
    label: str
    explain: str
    severity: str  # critical | serious | warning | info | good


SEVERITY_ICON = {"critical": "🔴", "serious": "🟠", "warning": "🟡", "info": "🔵", "good": "🟢"}
SEVERITY_ORDER = ("critical", "serious", "warning", "info", "good")
SEVERITY_TITLE = {
    "critical": "Bahaya: pool dikeluarkan dari rekomendasi",
    "serious": "Serius",
    "warning": "Waspada",
    "info": "Info",
    "good": "Mendukung LP",
}

FLAGS: dict[str, Flag] = {
    "rugged": Flag("Rugged", "RugCheck menandai token ini sudah rug.", "critical"),
    "mint_authority": Flag("Mint aktif", "Mint authority masih aktif: supply bisa dicetak lagi kapan saja.", "critical"),
    "freeze_authority": Flag("Freeze aktif", "Freeze authority aktif: token di wallet kamu bisa dibekukan.", "critical"),
    "cluster_10": Flag(
        "Kelompok ≥10%", "Wallet yang saling terhubung memegang ≥10% supply.", "serious"
    ),
    "cluster_5": Flag("Kelompok ≥5%", "Wallet terhubung memegang 5–10% supply.", "warning"),
    "suspicious_pool": Flag(
        "Sangat mencurigakan",
        "Tanda pool buatan pemilik token: holder sedikit, supply terpusat, tanpa harga pasar.",
        "critical",
    ),
    "transfer_fee": Flag(
        "Pajak transfer",
        "Pajak ≥1% tiap transfer: masuk/keluar posisi, klaim, swap.",
        "critical",
    ),
    "transfer_fee_low": Flag("Pajak transfer kecil", "Token memotong <1% setiap transfer.", "warning"),
    "transfer_fee_mutable": Flag(
        "Pajak bisa dinaikkan", "Pajak 0% tapi bisa dinaikkan pemilik token.", "warning"
    ),
    "rugcheck_danger": Flag("RugCheck danger", "RugCheck menemukan risiko level danger.", "critical"),
    "dumping": Flag("Dump", "Harga turun ≥15% dalam 1 jam.", "critical"),
    "pumping": Flag("Pump", "Harga naik ≥30% dalam 1 jam: LP berisiko menampung token di puncak.", "critical"),
    "strong_downtrend": Flag(
        "Tren turun kuat", "ADX ≥30 dengan −DI dominan dan EMA20 menurun (candle 30m): LP akan menampung jualan.",
        "critical",
    ),
    "tvl_suspect": Flag(
        "TVL mencurigakan",
        "TVL >2x likuiditas token di semua DEX dan <20% ditemukan di bin on-chain: angka TVL kemungkinan salah.",
        "critical",
    ),
    "organic_low": Flag(
        "Organic rendah",
        "Organic score Jupiter <40: aktivitas trading sebagian besar bot/wash, jadi fee/TVL menyesatkan.",
        "serious",
    ),
    "bundler_heavy": Flag(
        "Bundler ≥15%", "Wallet bundler (GMGN) memegang ≥15% supply: risiko dump terkoordinasi.", "serious"
    ),
    "extreme_volatility": Flag(
        "Sangat volatil", "ATR candle 30m ≥8%: range dan IL sulit dikendalikan.", "warning"
    ),
    "sell_pressure": Flag(
        "Tekanan jual", "1 jam terakhir: <40% transaksi beli dan penjual unik mendominasi.", "warning"
    ),
    "deep_drawdown": Flag("Drawdown >30%", "Harga turun >30% dari high 24 jam.", "warning"),
    "ath_drawdown": Flag(
        "Jauh di bawah ATH", "Market cap <30% dari all-time-high (pump.fun): fase turun setelah puncak.", "warning"
    ),
    "bot_holders_heavy": Flag("Bot holder ≥10%", "Wallet bot memegang ≥10% supply (audit Jupiter).", "warning"),
    "sniper_heavy": Flag("Sniper ≥15%", "Wallet sniper (GMGN) memegang ≥15% supply.", "warning"),
    "dev_holds": Flag("Dev pegang ≥5%", "Creator token masih memegang ≥5% supply (GMGN).", "warning"),
    "serial_dev": Flag(
        "Dev serial", "Creator sudah meluncurkan ≥20 token (GMGN): sering pola pabrik memecoin.", "warning"
    ),
    "smart_money_exit": Flag(
        "Smart money keluar", "≥3 wallet smart money dengan netflow USD negatif (GMGN).", "warning"
    ),
    "top_holders_50": Flag("Top10 ≥50%", "10 holder terbesar (tanpa pool/locker) memegang ≥50% supply.", "warning"),
    "top_holders_30": Flag("Top10 ≥30%", "10 holder terbesar (tanpa pool/locker) memegang ≥30% supply.", "warning"),
    "low_holders": Flag("Holder <1K", "Holder kurang dari 1.000.", "warning"),
    "low_mcap": Flag("Mcap <$1M", "Market cap di bawah $1M.", "warning"),
    "new_pool": Flag("Pool baru", "Pool berumur kurang dari 6 jam: data harga dan volume masih sedikit.", "warning"),
    "pump_banned": Flag(
        "Disembunyikan pump.fun",
        "pump.fun menyembunyikan koin ini dari situsnya. Moderasi situs, bukan risiko on-chain.",
        "info",
    ),
    "liquidity_elsewhere": Flag(
        "Likuiditas di PumpSwap",
        "Pool Meteora ini <30% dari likuiditas token: sebagian besar volume kemungkinan di venue lain.",
        "info",
    ),
    "tvl_unverified": Flag(
        "TVL belum terverifikasi",
        "TVL >2x likuiditas token di semua DEX; bin on-chain pool ini belum dibaca untuk memastikan.",
        "info",
    ),
    "organic_weak": Flag(
        "Organic lemah", "Organic score Jupiter 40–60: sebagian volume kemungkinan bukan pengguna asli.", "info"
    ),
    "paid_hype": Flag(
        "Boost berbayar", "Boost/iklan DexScreener dalam 24 jam: hype berbayar, sering diikuti dump.", "info"
    ),
    "security_pending": Flag("Cek keamanan", "Data RugCheck belum tersedia.", "info"),
    "issuer_controlled": Flag(
        "Issuer", "Token besar terverifikasi (wrapped/bridged): mint/freeze dikontrol penerbit resmi.", "info"
    ),
    "unverified": Flag("Unverified", "Token belum terverifikasi. Info saja, bukan tanda bahaya.", "info"),
    "high_volatility": Flag("Volatil", "Realized volatility 1 jam ≥20%.", "info"),
    "thin_liquidity": Flag("TVL tipis", "TVL di bawah $25K: slippage besar dan mudah ditinggal.", "info"),
    "fading_volume": Flag("Mulai sepi", "Laju fee 1 jam <25% dari rata-rata 24 jam.", "info"),
    "fee_spike": Flag(
        "Fee spike",
        "Dynamic fee ≥50% dari base fee: harga melintasi banyak bin. Peluang fee sekaligus risiko IL.",
        "info",
    ),
    "uptrend": Flag("Tren naik", "ADX ≥25 dengan +DI dominan: token terjual bertahap saat harga naik.", "info"),
    "bb_squeeze": Flag("BB squeeze", "Lebar Bollinger di 20% terendah: volatilitas bisa segera meledak.", "info"),
    "sideways": Flag("Sideways", "ADX rendah / Choppiness tinggi: kondisi ideal untuk LP dua sisi.", "good"),
}

KEYS = list(FLAGS)  # stable index: callback buttons carry indexes, Telegram caps callback data at 64 bytes


def flag(key: str) -> Flag:
    return FLAGS.get(key) or Flag(key.replace("_", " ").capitalize(), "Belum ada penjelasan untuk flag ini.", "info")


def sort_flags(keys: list[str]) -> list[str]:
    return sorted(dict.fromkeys(keys), key=lambda k: SEVERITY_ORDER.index(flag(k).severity))


def chip(key: str) -> str:
    f = flag(key)
    return f"{SEVERITY_ICON[f.severity]} {f.label}"


def encode(keys: list[str]) -> str:
    """Callback data for the Info flag button: 'fi:' plus the flags' indexes, capped to fit 64 bytes."""
    out = "fi:"
    for k in sort_flags(keys):
        if k not in FLAGS:
            continue
        piece = f"{KEYS.index(k)},"
        if len(out) + len(piece) > 64:
            break
        out += piece
    return out.rstrip(",")


def decode(data: str) -> list[str]:
    if not data.startswith("fi:"):
        return []
    return [KEYS[int(i)] for i in data[3:].split(",") if i.isdigit() and int(i) < len(KEYS)]


def explain(keys: list[str], title: str = "ℹ️ <b>Info flag</b>") -> str:
    """Telegram HTML: each flag with its explanation, worst first."""
    if not keys:
        return title + "\nTidak ada flag."
    lines = [title, ""]
    for k in sort_flags(keys):
        f = flag(k)
        lines.append(f"{SEVERITY_ICON[f.severity]} <b>{f.label}</b>\n{f.explain}")
    return "\n\n".join([lines[0], *lines[2:]])


def glossary() -> str:
    """Every flag, grouped by severity, for the /flags command."""
    parts = ["📖 <b>Daftar flag</b>", "Warna menunjukkan tingkat risiko. Flag 🔴 membuat pool tidak direkomendasikan."]
    for sev in SEVERITY_ORDER:
        keys = [k for k, f in FLAGS.items() if f.severity == sev]
        if keys:
            body = "\n".join(f"• <b>{FLAGS[k].label}</b>: {FLAGS[k].explain}" for k in keys)
            parts.append(f"{SEVERITY_ICON[sev]} <b>{SEVERITY_TITLE[sev]}</b>\n{body}")
    return "\n\n".join(parts)
