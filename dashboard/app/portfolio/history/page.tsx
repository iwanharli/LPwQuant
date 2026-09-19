import type { Metadata } from "next";
import HistoryPage from "../../components/portfolio/history-page";

export const metadata: Metadata = {
  title: "Riwayat · Portofolio LP · Quant",
  description: "Kekayaan total dan semua aktivitas wallet",
};

export default function Page() {
  return <HistoryPage />;
}
