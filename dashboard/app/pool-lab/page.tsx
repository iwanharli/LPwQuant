import { redirect } from "next/navigation";

// The pool-creator paper test was stopped on 2026-09-26; old links land on the paper overview.
export default function Page() {
  redirect("/paper");
}
