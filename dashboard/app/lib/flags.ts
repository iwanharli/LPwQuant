import type { Regime, Strategy, Tier } from "./types";

export type Severity = "good" | "info" | "warning" | "serious" | "critical";

// Keep in sync with RISKY_FLAGS in engine/app/scoring.py.
export const RISKY_FLAGS = new Set([
  "rugged",
  "mint_authority",
  "freeze_authority",
  "rugcheck_danger",
  "dumping",
  "pumping",
  "tvl_suspect",
  "transfer_fee",
  "suspicious_pool",
]);

type FlagMeta = { label: string; title: string; severity: Severity };

const FLAG_META: Record<string, FlagMeta> = {
  rugged: { label: "Rugged", title: "RugCheck menandai token ini sudah rug", severity: "critical" },
  mint_authority: { label: "Mint aktif", title: "Mint authority aktif: supply bisa dicetak lagi", severity: "critical" },
  freeze_authority: { label: "Freeze aktif", title: "Freeze authority aktif: token bisa dibekukan", severity: "critical" },
  suspicious_pool: {
    label: "☠ Sangat mencurigakan",
    title: "Beberapa tanda pool buatan pemilik token sekaligus: pemegang sangat sedikit, supply terpusat, tanpa harga pasar, atau TVL tanpa transaksi",
    severity: "critical",
  },
  cluster_10: {
    label: "Kelompok ≥10%",
    title: "Wallet yang saling transfer token ini memegang ≥10% supply: bisa jual serentak. Lihat peta pemegang",
    severity: "serious",
  },
  cluster_5: { label: "Kelompok ≥5%", title: "Wallet yang saling transfer token ini memegang 5–10% supply", severity: "warning" },
  transfer_fee: {
    label: "Pajak transfer",
    title: "Token memotong ≥1% setiap transfer: masuk/keluar posisi, klaim fee, dan swap semuanya kena",
    severity: "critical",
  },
  transfer_fee_low: { label: "Pajak transfer kecil", title: "Token memotong <1% setiap transfer", severity: "warning" },
  transfer_fee_mutable: {
    label: "Pajak bisa dinaikkan",
    title: "Pajak transfer 0% sekarang, tapi pemilik token masih bisa menaikkannya",
    severity: "warning",
  },
  rugcheck_danger: { label: "RugCheck", title: "RugCheck menemukan risiko level danger", severity: "critical" },
  dumping: { label: "Dump", title: "Harga turun ≥15% dalam 1 jam", severity: "critical" },
  pumping: {
    label: "Pump",
    title: "Harga naik ≥30% dalam 1 jam: LP berisiko menampung token di puncak",
    severity: "critical",
  },
  extreme_volatility: {
    label: "Sangat volatil",
    title: "ATR candle 30m ≥8%: range dan IL sulit dikendalikan",
    severity: "warning",
  },
  strong_downtrend: {
    label: "Tren turun kuat",
    title: "ADX ≥30 dengan −DI dominan dan EMA20 menurun (candle 30m)",
    severity: "critical",
  },
  sell_pressure: {
    label: "Tekanan jual",
    title: "1 jam terakhir: <40% transaksi beli dan penjual unik mendominasi",
    severity: "warning",
  },
  deep_drawdown: { label: "Drawdown >30%", title: "Harga turun >30% dari high 24 jam", severity: "warning" },
  pump_banned: {
    label: "Disembunyikan pump.fun",
    title: "pump.fun menandai koin ini banned (disembunyikan dari situs pump.fun). Moderasi situs, bukan risiko on-chain",
    severity: "info",
  },
  ath_drawdown: {
    label: "Jauh di bawah ATH",
    title: "Market cap <30% dari all-time-high (pump.fun): fase turun setelah puncak",
    severity: "warning",
  },
  liquidity_elsewhere: {
    label: "Likuiditas di PumpSwap",
    title: "Pool Meteora ini <30% dari likuiditas Meteora + PumpSwap token: sebagian besar volume kemungkinan di venue lain",
    severity: "info",
  },
  tvl_suspect: {
    label: "TVL mencurigakan",
    title: "TVL >2x likuiditas token di semua DEX (Jupiter) dan <20% ditemukan di bin on-chain: angka TVL kemungkinan salah",
    severity: "critical",
  },
  tvl_unverified: {
    label: "TVL belum terverifikasi",
    title: "TVL >2x likuiditas token di semua DEX (Jupiter); bin on-chain pool ini belum dibaca untuk memastikan",
    severity: "info",
  },
  organic_low: {
    label: "Organic rendah",
    title: "Organic score Jupiter <40 atau label low: aktivitas trading sebagian besar bot/wash, fee/TVL menyesatkan",
    severity: "serious",
  },
  organic_weak: {
    label: "Organic lemah",
    title: "Organic score Jupiter 40–60: sebagian volume kemungkinan bukan pengguna asli",
    severity: "info",
  },
  bot_holders_heavy: {
    label: "Bot holder ≥10%",
    title: "Wallet bot memegang ≥10% supply (audit Jupiter)",
    severity: "warning",
  },
  bundler_heavy: {
    label: "Bundler ≥15%",
    title: "Wallet bundler (GMGN) memegang ≥15% supply: risiko dump terkoordinasi",
    severity: "serious",
  },
  sniper_heavy: { label: "Sniper ≥15%", title: "Wallet sniper (GMGN) memegang ≥15% supply", severity: "warning" },
  dev_holds: { label: "Dev pegang ≥5%", title: "Creator token masih memegang ≥5% supply (GMGN)", severity: "warning" },
  serial_dev: {
    label: "Dev serial",
    title: "Creator sudah meluncurkan ≥20 token (GMGN): sering pola pabrik memecoin",
    severity: "warning",
  },
  smart_money_exit: {
    label: "Smart money keluar",
    title: "≥3 wallet smart money dengan netflow USD negatif (GMGN)",
    severity: "warning",
  },
  paid_hype: {
    label: "Boost berbayar",
    title: "Boost/iklan DexScreener dalam 24 jam terakhir: hype berbayar, sering diikuti dump",
    severity: "info",
  },
  top_holders_50: { label: "Top10 ≥50%", title: "10 holder terbesar (tanpa pool/locker) memegang ≥50%", severity: "warning" },
  top_holders_30: { label: "Top10 ≥30%", title: "10 holder terbesar (tanpa pool/locker) memegang ≥30%", severity: "warning" },
  low_holders: { label: "Holder <1K", title: "Holder kurang dari 1.000", severity: "warning" },
  low_mcap: { label: "Mcap <$1M", title: "Market cap di bawah $1M", severity: "warning" },
  new_pool: { label: "Pool baru", title: "Pool berumur kurang dari 6 jam", severity: "warning" },
  security_pending: { label: "Cek keamanan", title: "Data RugCheck belum tersedia", severity: "info" },
  issuer_controlled: {
    label: "Issuer",
    title: "Token besar terverifikasi (wrapped/bridged/tokenized): mint/freeze dikontrol penerbit",
    severity: "info",
  },
  unverified: { label: "Unverified", title: "Token belum terverifikasi (info saja)", severity: "info" },
  high_volatility: { label: "Volatil", title: "Realized volatility 1 jam ≥20%", severity: "info" },
  thin_liquidity: { label: "TVL tipis", title: "TVL di bawah $25K: slippage besar & mudah ditinggal", severity: "info" },
  fading_volume: { label: "Mulai sepi", title: "Laju fee 1 jam < 25% dari rata-rata 24 jam", severity: "info" },
  fee_spike: {
    label: "Fee spike",
    title: "Dynamic fee ≥50% dari base fee: harga melintasi banyak bin, fee per swap naik (peluang fee sekaligus risiko IL)",
    severity: "info",
  },
  sideways: { label: "Sideways", title: "ADX rendah / Choppiness tinggi: kondisi ideal untuk LP dua sisi", severity: "good" },
  uptrend: { label: "Tren naik", title: "ADX ≥25 dengan +DI dominan: token terjual bertahap saat naik", severity: "info" },
  bb_squeeze: {
    label: "BB squeeze",
    title: "Lebar Bollinger di 20% terendah: volatilitas bisa segera meledak",
    severity: "info",
  },
};

export const REGIME_META: Record<Regime, { label: string; severity: Severity; hint: string }> = {
  ranging: { label: "Sideways", severity: "good", hint: "Harga bolak-balik: ideal untuk LP dua sisi" },
  mixed: { label: "Campuran", severity: "info", hint: "Arah belum jelas" },
  trending_up: { label: "Tren naik", severity: "warning", hint: "Token terjual bertahap saat harga naik (IL vs HODL)" },
  trending_down: { label: "Tren turun", severity: "critical", hint: "LP menampung jualan: gunakan satu sisi atau hindari" },
};

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, serious: 1, warning: 2, good: 3, info: 4 };

export function flagMeta(flag: string): FlagMeta {
  return FLAG_META[flag] ?? { label: flag, title: flag, severity: "info" };
}

export function sortFlags(flags: string[]): string[] {
  return [...flags].sort((a, b) => SEVERITY_ORDER[flagMeta(a).severity] - SEVERITY_ORDER[flagMeta(b).severity]);
}

export const SEVERITY_DOT: Record<Severity, string> = {
  good: "bg-good",
  info: "bg-ink-3",
  warning: "bg-warning",
  serious: "bg-serious",
  critical: "bg-critical",
};

type BadgeMeta = { label: string; short: string; severity: Severity; hint: string };

export const TIER_META: Record<Tier, BadgeMeta> = {
  low: {
    label: "Risiko rendah",
    short: "Rendah",
    severity: "good",
    hint: "Return rendah · token aman, volatilitas rendah, likuiditas dalam · ukuran posisi penuh",
  },
  medium: {
    label: "Risiko menengah",
    short: "Menengah",
    severity: "warning",
    hint: "Return menengah · keamanan dan likuiditas cukup · ukuran posisi 60%",
  },
  high: {
    label: "Risiko tinggi",
    short: "Tinggi",
    severity: "serious",
    hint: "Return tinggi · volatil, TVL tipis, atau keamanan lemah · ukuran posisi 30%",
  },
};

export const STATUS_META: Record<"wait" | "avoid", BadgeMeta> = {
  wait: { label: "Tunggu data", short: "Tunggu", severity: "info", hint: "Riwayat harga/candle belum cukup" },
  avoid: {
    label: "Tidak direkomendasikan",
    short: "Tidak",
    severity: "critical",
    hint: "Flag keamanan berat, dump/pump, atau tren turun dengan tekanan jual",
  },
};

export const STRATEGY_LABEL: Record<Strategy, string> = { spot: "Spot", curve: "Curve", bid_ask: "Bid-Ask" };
