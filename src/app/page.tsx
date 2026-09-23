import { redirect } from "next/navigation";

// Only one feature is ported so far (m7, Expenses). Each later port adds its
// own route under (app)/; once more than one exists this should become a
// real landing screen instead of a redirect.
export default function Home() {
  redirect("/expenses");
}
