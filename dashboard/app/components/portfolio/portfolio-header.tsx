import type { ReactNode } from "react";
import PageHeader from "../page-header";

/** The portfolio sub-pages' header: the shared PageHeader with "Portofolio LP" as the default title. */
export default function PortfolioHeader({ subtitle, right, title = "Portofolio LP" }: { subtitle: string; right?: ReactNode; title?: string }) {
  return <PageHeader title={title} subtitle={subtitle} right={right} />;
}
