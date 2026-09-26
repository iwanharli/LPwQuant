/** Written review of each paper strategy: strengths, weaknesses, and what to change next. Updated by hand after each
 * analysis, with the date it was written, so the page never passes an old opinion off as current. */
export type StrategyNote = { written: string; basis: string; pros: string[]; cons: string[]; next: string[] };

export const STRATEGY_NOTES: Record<string, StrategyNote> = {
  satu_sisi: {
    written: "26 Sep 2026",
    basis: "28 posisi selesai sejak 16/09, +$35,86",
    pros: [
      "Rugi hampir tidak pernah besar: rata-rata menang +1,59%, rata-rata kalah hanya −0,16%. Satu kemenangan menutup ±10 kekalahan.",
      "IL nyaris nol (−0,03%): posisi satu sisi di bawah harga pada pool tenang (ATR ≤ 2%) jarang terkena pergerakan yang merugikan.",
      "Semua cara keluar untung rata-rata (keluar range, batas waktu, fee melemah, breakout).",
      "Biaya kecil (±0,08% per posisi) karena masuk tanpa swap.",
      "Tersebar di 20 pool berbeda, tidak bergantung pada satu token.",
    ],
    cons: [
      "Separuh untung dari satu posisi: AAVE-USDC (18/09) +$16,22. Fee-nya nyata, dari lonjakan volume ±$3 juta dalam satu jam (biasanya puluhan ribu), tapi kejadian langka seperti ini tidak bisa diandalkan; tanpa itu +$19,63.",
      "Untung per posisi kecil (±$1,28 dari modal $100).",
      "Jarang masuk: ratusan pool lolos seleksi tetapi hampir tidak ada yang lolos ATR ≤ 2% dan gerbang fee 2×.",
      "Yang dimasuki kebanyakan token besar (AAVE, xBTC, DOGE, MON, xHYPE), bukan memecoin.",
    ],
    next: [
      "Tetap jadi strategi andalan; nilai ulang saat posisi baru menggeser pengaruh AAVE.",
      "Cari tahu kenapa belakangan tidak ada posisi baru: apakah ATR ≤ 2% terlalu ketat untuk pasar sekarang.",
      "Bila mau dicoba nyata: ukuran kecil, hanya pool yang lolos checklist penuh.",
    ],
  },
  satu_sisi_sering: {
    written: "26 Sep 2026",
    basis: "14 posisi selesai sejak 24/09, +$1,62",
    pros: [
      "Rugi tetap sangat kecil (rata-rata kalah −0,09%).",
      "Membuktikan gerbang fee 2× di Ankylosaurus memang berguna.",
    ],
    cons: [
      "Praktis impas: 10 dari 14 posisi keluar range dengan hasil $0,00 (fee rata-rata 0,08%, dipegang ±1 jam).",
      "Rata-rata menang hanya +0,40%, empat kali lebih kecil dari Ankylosaurus.",
      "Lebih sering masuk tetapi kualitasnya turun: gerbang 1× memasukkan pool yang fee-nya tidak cukup.",
    ],
    next: [
      "Kandidat dihentikan: pertanyaan yang diujinya sudah terjawab (gerbang 2× lebih baik).",
      "Dibiarkan berjalan dulu atas permintaan; nilai lagi setelah 20 posisi.",
    ],
  },
  panda: {
    written: "26 Sep 2026",
    basis: "6 posisi selesai, −$1,86 setelah rumus fee dikoreksi",
    pros: [
      "Seleksi pool paling ketat: token sampah tersaring.",
      "5 dari 6 posisi untung; exit RSI(2) cukup baik menangkap pantulan.",
      "COLLECT-SOL membuktikan idenya bisa jalan: turun −52,6%, memantul, +$5,17.",
    ],
    cons: [
      "Fee sangat kecil ($0,11–6,49, kebanyakan < $2) karena modal tersebar di ±233 bin.",
      "Satu kekalahan menghapus semua kemenangan: GO-SOL −$12,36, lebih besar dari lima kemenangan lain (+$10,50).",
      "Sering turun dalam sebelum memantul (−34%, −40%, −53%, −64%); tanpa stop, satu yang tak kembali bisa −50% lebih.",
      "Keluar di pantulan meski masih rugi (GO-SOL di −45%).",
      "Modal tertahan lama (5–17 jam per posisi).",
    ],
    next: [
      "Jalankan tanpa diubah sampai 20 posisi selesai, lalu nilai terutama rugi posisi yang tak memantul.",
      "Setelah itu uji rencana perbaikan di bawah ini berdampingan dengan versi sekarang.",
    ],
  },
  copy: {
    written: "26 Sep 2026",
    basis: "baru dimulai",
    pros: [
      "Posisi LP terlihat utuh di blockchain (pool, range, ukuran), jadi bisa ditiru persis, bukan menebak.",
      "Wallet yang diikuti sudah lolos kriteria yang sama dengan uji paper: median dan hasil tanpa 3 terbaik positif.",
      "Jeda deteksi dihitung sungguhan, jadi hasilnya adalah yang benar-benar tersisa untuk peniru.",
    ],
    cons: [
      "Masa lalu tidak menjamin masa depan: wallet yang bagus minggu lalu bisa berhenti bagus.",
      "Wallet bot dengan posisi sangat singkat sulit ditiru; hasilnya banyak hilang di jeda.",
      "Untung per posisi wallet besar tipis dalam persen; dengan modal $100, biaya tetap terasa lebih berat.",
    ],
    next: [
      "Biarkan 1–2 minggu, lalu bandingkan hasil tiruan dengan hasil wallet aslinya.",
      "Bila jeda memakan sebagian besar hasil, pilih wallet dengan lama pegang lebih panjang.",
    ],
  },
  sol_grid: {
    written: "26 Sep 2026",
    basis: "belum ada order terisi",
    pros: [
      "Tanpa risiko rug, pajak transfer, atau token jatuh −90%.",
      "Simulasi 30 hari: semua putaran untung (+8,3% sebulan dengan jarak 1%).",
    ],
    cons: [
      "Belum ada satu order pun terisi: SOL belum pernah turun 1% sejak mulai.",
      "Di pasar naik kalah dari sekadar memegang SOL (simulasi +8,3% vs +19,4%).",
      "Tanpa stop-loss: bila SOL turun > 5%, semua level memegang SOL yang terus turun.",
    ],
    next: [
      "Biarkan 1–2 minggu, idealnya melewati periode SOL turun.",
      "Bandingkan selalu dengan memegang SOL; bila kalah terus di pasar naik, pertimbangkan jarak level lebih rapat (0,5%).",
    ],
  },
};
