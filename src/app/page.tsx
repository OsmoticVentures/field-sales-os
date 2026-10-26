import { redirect } from "next/navigation";

// The app root lands on Route, the first screen a rep opens (Juan, 2026-10-26). next.config.ts
// answers "/" at the edge before this runs; this is the fallback.
export default function Home() {
  redirect("/route");
}
