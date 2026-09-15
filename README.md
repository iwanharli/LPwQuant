# LPwQuant

Live screener untuk pool **Meteora DLMM**. Tahap 1 hanya membaca data: tidak ada wallet dan tidak ada eksekusi.

```
Meteora API (poll) ─┐
                    ├─► ingestor (TS) ──► Postgres (db_quant) + Redis streams
Solana WS (Helius) ─┘                              │
                                                   ▼
                                     engine (Python, FastAPI) ── metrik + skor
                                                   │  REST /api/pools, WS /ws
                                                   ▼
                                     dashboard (Next.js) :3000
```

## Prasyarat (native, tanpa Docker)
- Node 22, [uv](https://docs.astral.sh/uv/)
- PostgreSQL (Postgres.app) di `localhost:5432`, dengan database `db_quant` (`createdb db_quant`)
- Redis di `localhost:6379` (`brew services start redis`)

## Setup
```bash
cp .env.example .env          # isi HELIUS_API_KEY untuk harga on-chain real-time
cd ingestor && npm install
cd ../engine && uv sync
cd ../dashboard && npm install
```
Tabel dibuat otomatis saat ingestor atau engine start (`db/schema.sql`).

## Menjalankan (3 terminal)
```bash
cd ingestor  && npm run dev                                   # poll API + watcher on-chain
cd engine    && uv run uvicorn app.main:app --port 8000 --reload
cd dashboard && npm run dev                                   # http://localhost:3000
```

Tanpa `HELIUS_API_KEY`, ingestor tetap jalan dalam mode polling API saja (default tiap 60 detik). Dengan key, harga on-chain `WATCH_TOP_N` pool teratas dipantau dengan salah satu mode:
- `WATCH_MODE=poll` (default): 1 panggilan `getMultipleAccounts` tiap `WATCH_POLL_INTERVAL_SEC` (10 detik), sekitar 260 ribu panggilan per bulan, muat di paket gratis.
- `WATCH_MODE=ws`: `accountSubscribe` real-time. Terukur ±200–300 pesan per menit untuk 25 pool; cek dulu apakah provider menghitungnya sebagai kredit.

Pemakaian RPC tercatat di tabel `rpc_usage` dan tampil di panel dashboard. `RPC_FALLBACKS` menambahkan provider cadangan untuk failover HTTP.

## Data
| Tempat | Isi |
|---|---|
| `pools` | metadata pool |
| `pool_snapshots` | snapshot API per poll (harga, TVL, volume, fee, info token) |
| `price_ticks` | perubahan bin aktif on-chain |
| `pool_metrics` | output engine: skor, perubahan harga 1 jam, realized vol, flag |
| Redis `pools:latest` | hash snapshot terbaru per pool |
| Redis `stream:pools`, `stream:prices` | event dari ingestor ke engine |

Data yang lebih tua dari `RETENTION_HOURS` dihapus otomatis. Waktu ditampilkan dalam GMT+7 (WIB).

## Data pasar: candle & arus transaksi (`ingestor/src/market.ts`)
- **Candle 30m** dari API OHLCV Meteora (harga dalam token quote, volume USD). Tiap pool di-refresh ±10 menit. API membatasi 48 jam per request, jadi riwayat lebih panjang diambil dengan backfill:
  ```bash
  cd ingestor && npm run backfill -- --days 7 --top 50
  ```
- **Arus transaksi** (jumlah buy/sell dan wallet unik per 5m–24j) dari GeckoTerminal, 30 pool per request, tiap 2 menit. Arah buy/sell disesuaikan dengan token dasar pool kita.
- Disimpan di tabel `candles` (retensi 30 hari) dan `pool_flow`, plus Redis `flow:latest`.

## Paper trading (`engine/app/paper.py`, halaman `/paper`)
Posisi LP **virtual** dibuka dan dikelola otomatis oleh engine. Tidak ada transaksi, wallet, atau private key.
- **Entry:** tiap siklus engine (±60 detik), pool dengan rencana "enter" diurutkan per skor. Maksimal `PAPER_MAX_OPEN_PER_TIER` posisi per tier (default 5), satu posisi per pool dan per token, dan pool yang baru ditutup menunggu `PAPER_COOLDOWN_HOURS` (6 jam). Ukuran, range, min/max price, dan aturan exit diambil dari rencana posisi saat itu.
- **Pembaruan:** nilai posisi memakai model bin yang sama seperti backtest, fee dari fee/TVL 1 jam pool selama harga di dalam range (dikurangi dilusi), dan IL dibanding HODL.
- **Exit:** stop loss, keluar range, breakout Donchian, fee melemah, batas waktu, atau pool tidak dipantau lagi.
- **Data:** `paper_positions` (termasuk snapshot plan, flag, indikator, keamanan, dan GMGN saat entry) dan `paper_equity`.
- **API:** `/api/paper/summary` (equity, hasil per tier dan strategi dengan 95% CI), `/api/paper/positions?status=open|closed`, `/api/paper/equity?hours=`.
- PnL dihitung dalam token Y pool (biasanya SOL/USDC) dan dikonversi ke USD dengan modal awal, jadi pergerakan harga SOL/USD tidak ikut dihitung.

### Biaya eksekusi di paper trading (`CostModel`)
PnL yang ditampilkan adalah PnL **bersih**, dengan PnL kotor (sebelum biaya) sebagai pembanding.

| Biaya | Model | Setting |
|---|---|---|
| Transaksi | 2 tx buka + 2 tx tutup per posisi | `PAPER_TX_COST_SOL` (0,00015 SOL/tx: base fee + priority fee) |
| Swap masuk | Porsi base token dari range (bin di atas harga + separuh bin aktif) × (fee pool + price impact). Bid-Ask satu sisi hampir tanpa swap | |
| Swap keluar | Nilai base token yang dipegang saat exit × (fee pool + price impact). Untuk posisi terbuka dihitung ulang tiap siklus sebagai biaya keluar sekarang | |
| Price impact | nilai swap ÷ TVL pool × multiplier, maksimal 5% | `PAPER_IMPACT_MULTIPLIER` (1,0) |
| Rent posisi | 0,0574 SOL per posisi (SDK `POSITION_FEE`), dikunci lalu **kembali** saat ditutup, jadi tidak dikurangkan | |
| Rent bin array | 0,0714 SOL per bin array (SDK `BIN_ARRAY_FEE`), tidak kembali; default dianggap sudah ada | `PAPER_NEW_BIN_ARRAY_SHARE` (0) |

Semua biaya bisa dimatikan dengan `PAPER_COSTS_ENABLED=false`. Posisi yang dibuka sebelum model biaya aktif tidak punya biaya masuk, hanya perkiraan biaya keluar.

## Insider & dev dari GMGN (`ingestor/src/gmgn.ts`)
Butuh API key GMGN read-only:
```bash
npx gmgn-cli@1.6.4 config                     # buat key pair, tempel public key di gmgn.ai/ai
npx gmgn-cli@1.6.4 config --apply <API_KEY>   # simpan ke ~/.config/gmgn/.env
```
Ingestor hanya membaca `GMGN_API_KEY`. Endpoint yang dipakai tidak butuh tanda tangan, jadi private key tidak disentuh.
- `token info` untuk semua token dasar pool, tiap `GMGN_INFO_REFRESH_MIN` (60 menit): riwayat dev (jumlah token yang pernah dibuat, saldo dev, sumber dana), volume beli/jual USD, boost/iklan DexScreener, community takeover.
- `token_top_holders` dengan tag `bundler`, `sniper`, `smart_degen`, `renowned` untuk `GMGN_HOLDERS_TOP_N` token teratas, tiap `GMGN_HOLDERS_REFRESH_MIN` (120 menit): jumlah wallet, % supply, netflow USD.
- Laju dibatasi jauh di bawah paket Free (weight 5/detik): 1 request per 1,2 detik (bobot 1) dan per 2,5 detik (bobot 5). Kalau kena rate limit, fetcher berhenti total sampai waktu reset dari server.
- Disimpan di `token_insights` (terbaru), `token_insight_snapshots` (riwayat 30 hari, untuk backtest nanti), dan Redis `gmgn:latest`.

Penalti keamanan (dilewati untuk token issuer besar):

| Flag | Syarat | Penalti |
|---|---|---|
| `bundler_heavy` | bundler memegang ≥15% supply | −8 |
| `dev_holds` | creator memegang ≥5% supply | −5 |
| `sniper_heavy` | sniper memegang ≥15% supply | −5 |
| `smart_money_exit` | ≥3 wallet smart money dengan netflow USD negatif | −5 |
| `serial_dev` | creator pernah membuat ≥20 token | −3 |
| `paid_hype` | boost/iklan DexScreener dalam 24 jam | info |

Ambang ini tebakan awal. Validasi setelah `token_insight_snapshots` punya riwayat beberapa minggu.

## Indikator teknikal (`engine/app/indicators.py`)
| Indikator | Dipakai untuk |
|---|---|
| ADX 14 (+DI/−DI), Choppiness 14 | **Rezim**: `trending_up`/`trending_down` (ADX ≥25), `ranging` (ADX <20 atau Choppiness ≥61,8), `mixed` |
| ATR 14 | Lebar range: 1,5 × ATR% × √(jumlah candle selama `HOLD_HOURS`) |
| Bollinger 20 + squeeze | Squeeze (lebar di 20% terendah) → range dilebarkan 30% |
| RSI 14 | Catatan oversold/overbought di rencana |
| EMA 20 slope | Konfirmasi tren turun kuat |
| Donchian 20 | Exit saat harga menembus channel |
| Drawdown dari high 24j | Flag `deep_drawdown` |
| Rasio buy/sell & wallet unik 1j | Flag `sell_pressure` |

## Skor v2 (`engine/app/scoring.py`)
Heuristik transparan dengan skala 0–100. **Bobotnya harus divalidasi dengan backtest. Bukan saran finansial.**
- **Peluang (70):**
  - fee 35: perkiraan fee harian untuk *ukuran posisimu* (bobot 24j 20%, 4j 40%, 1j 40%), sudah dikurangi dilusi
  - momentum 10: laju fee 1 jam dibanding rata-rata 24 jam
  - likuiditas 15: TVL skala log ($10K → 0, $1M → penuh)
  - perputaran 5: Volume/TVL
  - rezim 5: sideways 5, campuran 2,5, naik 1, turun 0
- **Risiko pasar** (mengurangi skor keamanan): `strong_downtrend` −8 (ADX ≥30, −DI dominan, EMA turun), `sell_pressure` −5, `deep_drawdown` −5, `dumping` −10.
- **Keamanan (30):** penalti untuk mint authority, freeze authority, top 10 holder ≥30/50% (tanpa pool/locker), risiko RugCheck level "danger" yang *belum* tercakup cek lain, holder < 1k, mcap < $1M, pool < 6 jam, dump ≥15%/jam. Token yang rugged skornya maksimal 10.
  - Risiko RugCheck yang sudah dicek terpisah (authority, konsentrasi holder) dan "LP Unlocked" (tidak relevan untuk DLMM) tidak dihitung dua kali.
  - Token terverifikasi dengan mcap ≥ $50M (wrapped/bridged/tokenized: cbBTC, WBTC, saham) diberi flag `issuer_controlled`, tanpa penalti authority dan konsentrasi holder.
- Flag informatif tanpa penalti: `unverified`, `issuer_controlled`, `high_volatility`, `thin_liquidity`, `fading_volume`.

## Keamanan token (`ingestor/src/security.ts`)
Report RugCheck untuk token non-quote tiap pool diambil satu per satu (jeda 1,5 detik, cache 30 menit). Hasilnya disimpan di `token_security` dan Redis `security:latest`.

## Rencana posisi (`engine/app/recommend.py`)
Setiap pool masuk salah satu dari **3 tier risiko** (`engine/app/tiers.py`):

| Tier | Syarat (semua terpenuhi) | Ukuran posisi |
|---|---|---|
| **Risiko rendah** (return rendah) | keamanan ≥ 25/30, volatilitas (ATR 30m) ≤ 2%, TVL ≥ $100K, tidak tren turun | 100% × `MAX_POSITION_PCT` |
| **Risiko menengah** (return menengah) | keamanan ≥ 15/30, volatilitas ≤ 5%, TVL ≥ $25K, tidak tren turun kuat | 60% |
| **Risiko tinggi** (return tinggi) | sisanya yang lolos filter dasar | 30% |

Skor dipakai untuk mengurutkan pool di dalam tier, bukan sebagai syarat masuk. Backtest dan validasi melaporkan hasil per tier, untuk mengecek apakah risiko lebih tinggi memang memberi return lebih tinggi.

Di luar tier:
- **Tidak direkomendasikan:** flag berat (rug, mint/freeze authority, RugCheck danger), dump ≤ −15%/jam, pump ≥ +30%/jam, atau tren turun kuat *dan* tekanan jual sekaligus.
- **Tunggu data:** belum ada riwayat harga atau candle.

Tiap pool yang masuk tier juga mendapat:
- **Strategi** (berdasarkan rezim; tanpa candle memakai perubahan 1 jam):
  - tren turun → Bid-Ask satu sisi (SOL/USDC di bawah harga)
  - tren naik → Spot condong ke atas
  - sideways dengan ATR < 1,5% → Curve
  - sideways bergejolak / campuran → Spot
- **Range:** yang lebih lebar antara ±2σ realized volatility × √`HOLD_HOURS` dan 1,5 × ATR × √candle; squeeze → ×1,3; dibatasi 2–60%, lalu dikonversi ke jumlah bin dan posisi (70 bin per posisi).
- **Ukuran:** `PORTFOLIO_USD` × `MAX_POSITION_PCT` × pengali tier × (keamanan/30), maksimal 2% TVL pool.
- **Exit:** stop loss PnL total (0,75 × lebar range, dibatasi 5–20%), di luar range >20 menit, harga menembus Donchian 20, laju fee turun <25% dari saat entry, atau ditahan >2× `HOLD_HOURS`.

Klik baris di dashboard untuk melihat rencana, aturan exit, dan detail keamanan.

## Backtest (`engine/app/backtest.py`)
Untuk setiap entry, backtest memakai rencana posisi yang *akan* disarankan pada saat itu (termasuk indikator yang dihitung hanya dari candle yang sudah tutup), lalu menjalankan aturan exit-nya.
```bash
cd engine
uv run python -m app.backtest --source candles --hours 48 --every 60     # langsung bisa, dari candle
uv run python -m app.backtest --source snapshots --hours 24 --every 60   # dari rekaman sendiri, lebih halus
# atau: curl 'localhost:8000/api/backtest?source=candles&hours=48&every=60'
```
- `candles`: harga = close candle 30m, fee = volume candle × base fee / TVL terbaru (fee dinamis diabaikan, jadi fee cenderung terlalu rendah). Skor keamanan memakai nilai hari ini; flag pasar dan rezim dihitung ulang per entry. Jalankan backfill untuk riwayat lebih panjang.
- `snapshots`: harga dari `price_ticks`/`pool_snapshots`, fee dari snapshot, skor sesuai saat entry. Hanya sepanjang rekaman sistem ini.

Hasil dikelompokkan per rezim, per aksi, per strategi (dan per skor untuk `snapshots`): win rate, rata-rata/median/p10 return, fee, IL vs HODL, dan alasan exit. Kalau suatu rezim atau strategi konsisten merugi, aturannya perlu diubah.

### Eksperimen varian aturan (`engine/app/experiment.py`)
Memuat data candle sekali, lalu membandingkan beberapa varian `PlanParams` di data yang sama:
```bash
cd ingestor && npm run backfill -- --days 7 --top 100   # riwayat dulu
cd engine && uv run python -m app.experiment --hours 168 --every 60
```
Parameter yang diuji (default di `PlanParams`, `engine/app/recommend.py`):
| Parameter | Arti |
|---|---|
| `pump_threshold_pct` | Hindari entry setelah naik ≥ X% dalam 1 jam (`None` = mati) |
| `breakout_buffer_pct` | Exit saat harga keluar channel Donchian ± buffer (`None` = tanpa exit breakout) |
| `max_atr_pct` | Hindari pool dengan ATR 30m di atas X% (`None` = mati) |
| `curve_max_atr_pct` | Sideways dengan ATR di bawah X% memakai Curve |

Skor juga memberi penalti `pumping` (naik ≥30%/jam, −10) dan `extreme_volatility` (ATR 30m ≥8%, −5).

### Validasi statistik (`engine/app/validation.py`)
```bash
cd ingestor && npm run backfill -- --universe recent --days 7 --min-cum-volume 250000
cd engine && uv run python -m app.validation --hours 168 --train-hours 72 --test-hours 24
```
- **Bootstrap per jam entry:** 95% CI untuk rata-rata return tiap varian, dan selisih terhadap `defaults` (dipasangkan pada jam yang sama). Trade di jam yang sama dianggap satu klaster karena pasar bergerak bersama.
- **Walk-forward:** varian terbaik dipilih di jendela latih (trade yang exit-nya melewati jendela latih dibuang), lalu diukur di jendela uji berikutnya yang belum pernah dilihat. Hasil out-of-sample dibandingkan dengan `defaults` yang tetap.
- **Survivorship bias:**
  - Backtest candle memasukkan pool ke universe hanya jika volume 24 jam *saat entry* ≥ $50K, bukan berdasarkan daftar pool hari ini.
  - TVL historis tidak diketahui, jadi dipakai TVL hari ini dengan batas bawah volume 24j / 20 (pool mati tidak mendapat fee/TVL yang tidak masuk akal).
  - Backfill `--universe recent` memindai semua pool dan mengambil yang dibuat dalam `--days` terakhir dengan volume kumulatif ≥ ambang, termasuk yang sudah mati. Pool lama yang mati di dalam periode masih bisa terlewat.
  - Pool tanpa skor hari ini tetap disimulasikan dengan keamanan netral (15/30) dan tanpa flag token.

Asumsi penyederhanaan: likuiditas rata di semua bin, posisi mendapat fee/TVL rata-rata pool selama in-range (dikurangi dilusi), nilai dalam token quote, tanpa biaya transaksi/rent/slippage.

## Test
```bash
cd engine && uv run pytest
cd ingestor && npm run typecheck
```
