import type { Metadata } from "next";
import OrdersPage from "../../components/portfolio/orders-page";

export const metadata: Metadata = {
  title: "Limit order · Portofolio LP · Quant",
  description: "Limit order Meteora yang masih terbuka",
};

export default function Page() {
  return <OrdersPage />;
}
