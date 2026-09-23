/**
 * Search. Draw an area, sweep one category of business inside it, pick what
 * lands on the cold-call schedule. Ported from
 * portfolio/src/app/nutribiotic/search/page.tsx.
 *
 * NOTHING RUNS ON ITS OWN. Searching spends real Google calls, looking
 * further fetches real websites, and adding to SDR is the only thing here
 * that writes a row. The page loads inert.
 */
import { PageHead } from "../../../lib/core/ui";
import { SearchClient } from "./SearchClient";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Search · Field Sales OS",
  appleWebApp: { title: "Search" },
};

export default function SearchPage() {
  return (
    <>
      <PageHead title="Search" />
      <SearchClient />
    </>
  );
}
