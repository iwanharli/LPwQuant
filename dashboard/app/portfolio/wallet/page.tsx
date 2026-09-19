import { redirect } from "next/navigation";

// The wallet page moved out of the portfolio tabs; old links and bookmarks land on its new address.
export default function Page() {
  redirect("/wallet");
}
