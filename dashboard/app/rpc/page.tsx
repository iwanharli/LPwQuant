import type { Metadata } from "next";
import RpcPage from "../components/rpc-page";

export const metadata: Metadata = {
  title: "Pemakaian API · Quant",
  description: "Jumlah panggilan RPC dan API per sumber dan proyeksi kuota",
};

export default function Page() {
  return <RpcPage />;
}
