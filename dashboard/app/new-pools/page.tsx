import type { Metadata } from "next";
import NewPoolsPage from "../components/new-pools-page";

export const metadata: Metadata = {
  title: "Pool baru · Quant",
  description: "Pool DLMM yang baru dibuat, dengan cek keamanan otomatis",
};

export default function Page() {
  return <NewPoolsPage />;
}
