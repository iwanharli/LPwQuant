import type { Metadata } from "next";
import PandaPage from "../components/panda-page";

export const metadata: Metadata = {
  title: "Uji Panda Strat · Quant",
  description: "Uji paper strategi Panda: seleksi ketat, range lebar satu sisi, keluar di pantulan pertama",
};

export default function Page() {
  return <PandaPage />;
}
