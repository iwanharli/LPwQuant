import type { Metadata } from "next";
import TopBar from "../components/top-bar";
import MomentumPanel from "../components/momentum-panel";

export const metadata: Metadata = {
  title: "Bot swap · Quant",
  description: "Backtest bot swap momentum: beli saat sinyal, jual di target atau stop",
};

export default function Page() {
  return (
    <div className="flex min-h-screen min-w-0 flex-col overflow-x-hidden">
      <TopBar />
      <main className="mx-auto w-full min-w-0 max-w-full flex-1 space-y-5 overflow-x-hidden px-4 py-6 sm:px-6 lg:py-7 2xl:px-8">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-ink sm:text-4xl">Bot swap momentum</h1>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-ink-3">
            Beli token saat sinyal muncul, jual di target, stop, atau batas waktu. Ini taruhan arah, berbeda dari
            posisi LP di halaman lain. Setiap varian dibandingkan dengan membeli token yang sama di saat yang sama
            lalu sekadar menahannya, supaya pasar yang sedang naik tidak disalahartikan sebagai sinyal yang bekerja.
          </p>
        </div>
        <MomentumPanel />
      </main>
    </div>
  );
}
