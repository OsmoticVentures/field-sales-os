/**
 * Workflow. NutriBiotic's AI-first marketing workflow maps and the Drive
 * folder layout behind them, drawn here instead of in a slide deck so the
 * map and the folders are one editable source. Data in nb_workflow_items
 * (supabase/0012), read and written through /api/workflow.
 */
import { WorkflowClient } from "./WorkflowClient";

// Static: served from the CDN, gated by proxy, data loads through an API
// route that checks access.
export const dynamic = "force-static";

export const metadata = {
  title: "Workflow · ClientOS",
  appleWebApp: { title: "Workflow" },
};

export default function WorkflowPage() {
  return <WorkflowClient />;
}
