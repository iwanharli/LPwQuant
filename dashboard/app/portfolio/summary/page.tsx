import type { Metadata } from "next";
import SummaryPage from "../../components/portfolio/summary-page";

export const metadata: Metadata = {
  title: "Ringkasan · Portofolio LP · Quant",
  description: "Modal, kekayaan sekarang, dan dari mana untung-ruginya",
};

export default function Page() {
  return <SummaryPage />;
}
