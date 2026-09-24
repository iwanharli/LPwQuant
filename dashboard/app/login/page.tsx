import type { Metadata } from "next";
import LoginPage from "../components/login-page";

export const metadata: Metadata = {
  title: "Masuk · Quant",
  description: "Masuk dengan passkey Touch ID",
};

export default function Page() {
  return <LoginPage />;
}
