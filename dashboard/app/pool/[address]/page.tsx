import type { Metadata } from "next";
import PoolPage from "../../components/pool/pool-page";

export const metadata: Metadata = {
  title: "Grafik pool · Quant",
  description: "Candlestick, rekomendasi range dan posisi paper per pool",
};

export default async function Page({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  return <PoolPage address={address} />;
}
