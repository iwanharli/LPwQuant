import type { Metadata } from "next";
import PageHeader from "../components/page-header";
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
        <PageHeader title="Pemakaian API" subtitle="Panggilan RPC dan API data per sumber, untuk memantau kuota." />
        <UsagePanel />
      </main>
    </div>
  );
}
