import type { Metadata } from "next";
import TopBar from "../components/top-bar";
import UsagePanel from "../components/usage-panel";

export const metadata: Metadata = {
  title: "Pemakaian API · Quant",
  description: "Jumlah panggilan RPC dan API per sumber dan proyeksi kuota",
};

export default function Page() {
  return (
    <div className="flex min-h-screen min-w-0 flex-col overflow-x-hidden">
      <TopBar />
      <main className="mx-auto w-full min-w-0 max-w-full flex-1 space-y-5 overflow-x-hidden px-4 py-6 sm:px-6 lg:py-7 2xl:px-8">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-ink sm:text-4xl">Pemakaian API</h1>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-ink-3">
            Panggilan ke RPC Solana dan API data (Meteora, GeckoTerminal, RugCheck, Jupiter, GMGN, pump.fun) untuk memantau kuota. Diperbarui setiap 30 detik.
          </p>
        </div>
        <UsagePanel />
      </main>
    </div>
  );
}
