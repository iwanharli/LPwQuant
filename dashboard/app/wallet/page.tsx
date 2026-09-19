import type { Metadata } from "next";
import WalletPage from "../components/portfolio/wallet-page";

export const metadata: Metadata = {
  title: "Wallet · Quant",
  description: "Koin di wallet kamu, di luar posisi LP",
};

export default function Page() {
  return <WalletPage />;
}
