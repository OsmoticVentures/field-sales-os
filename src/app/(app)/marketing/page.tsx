/**
 * Marketing. The NutriBiotic marketing roadmap with the sales strategy
 * roadmap under it, moved here from a claude.ai artifact on 2026-10-08. Data
 * in nb_roadmap_items (supabase/0011), read and written through
 * /api/marketing; the board code is lib/features/roadmap/board.ts.
 */
import { RoadmapClient } from "./RoadmapClient";

// Static: served from the CDN, gated by proxy, data loads through an API
// route that checks access.
export const dynamic = "force-static";

export const metadata = {
  title: "Marketing · ClientOS",
  appleWebApp: { title: "Marketing" },
};

export default function MarketingPage() {
  return <RoadmapClient />;
}
