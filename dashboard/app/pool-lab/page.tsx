import { redirect } from "next/navigation";

// Moved into the Paper trading page; old links and bookmarks land on the right tab.
export default function Page() {
  redirect("/paper?tab=pool");
}
