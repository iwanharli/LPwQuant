import type { Metadata } from "next";
import DangerPage from "../components/danger-page";

export const metadata: Metadata = {
  title: "Wallet berbahaya · Quant",
  description: "Pembuat pool yang menguras pool-nya setelah peluncuran atau membuat pool sangat mencurigakan",
};

export default function Page() {
  return <DangerPage />;
}
