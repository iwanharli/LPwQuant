import type { Metadata } from "next";
import PaperPage from "../components/paper/paper-page";

export const metadata: Metadata = {
  title: "Paper trading · Quant",
  description: "Posisi LP virtual dari rencana posisi live",
};

export default function Page() {
  return <PaperPage />;
}
