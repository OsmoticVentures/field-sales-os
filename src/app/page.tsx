import { redirect } from "next/navigation";

// The app root lands on Visit, the first screen a rep opens. next.config.ts
// answers "/" at the edge before this runs; this is the fallback.
export default function Home() {
  redirect("/visit");
}
