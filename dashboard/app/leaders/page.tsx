import type { Metadata } from "next";
import LeadersPage from "../components/leaders-page";

export const metadata: Metadata = {
  title: "LP teratas · Quant",
  description: "Wallet LP Meteora yang konsisten untung, dinilai dengan ukuran yang sama dengan uji paper",
};

export default function Page() {
  return <LeadersPage />;
}
