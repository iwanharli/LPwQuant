import type { Metadata } from "next";
import PoolLabPage from "../components/pool-lab-page";

export const metadata: Metadata = {
  title: "Uji pembuat pool · Quant",
  description: "Uji paper: apakah membuat pool DLMM dengan fee tinggi menguntungkan",
};

export default function Page() {
  return <PoolLabPage />;
}
