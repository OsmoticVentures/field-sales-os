import { redirect } from "next/navigation";

// The app root lands on the day's route, the first screen a rep opens.
export default function Home() {
  redirect("/route");
}
