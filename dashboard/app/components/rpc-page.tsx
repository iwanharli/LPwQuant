"use client";

import { useState } from "react";
import type { UsageItem } from "../lib/types";
import PageHeader from "./page-header";
import SourcesPanel from "./sources-panel";
import TopBar from "./top-bar";
import UsagePanel from "./usage-panel";

/** Where the app's data comes from: what each source supplies, how fresh it is, and how many calls it costs. */
export default function RpcPage() {
  const [items, setItems] = useState<UsageItem[] | null>(null);
  return (
    <div className="flex min-h-screen min-w-0 flex-col overflow-x-hidden">
      <TopBar />
      <main className="mx-auto w-full min-w-0 max-w-full flex-1 space-y-5 overflow-x-hidden px-4 py-6 sm:px-6 lg:py-7 2xl:px-8">
        <PageHeader title="Sumber data & pemakaian API" subtitle="Dari mana tiap angka berasal, seberapa segar, dan berapa panggilan yang dipakai." />
        <SourcesPanel items={items} />
        <UsagePanel onItems={setItems} />
      </main>
    </div>
  );
}
