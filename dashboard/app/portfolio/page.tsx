import type { Metadata } from "next";
import PortfolioPage from "../components/portfolio/portfolio-page";

export const metadata: Metadata = {
  title: "Portofolio LP · Quant",
  description: "Posisi DLMM Meteora milik wallet kamu dan keuntungan per hari",
};

export default function Page() {
  return <PortfolioPage />;
}
