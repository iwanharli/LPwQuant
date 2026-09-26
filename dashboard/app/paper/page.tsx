import type { Metadata } from "next";
import PaperHub from "../components/paper/paper-hub";

export const metadata: Metadata = {
  title: "Paper trading · Quant",
  description: "Semua uji paper: profil LP dan Panda, dengan ukuran yang sama",
};

export default function Page() {
  return <PaperHub />;
}
