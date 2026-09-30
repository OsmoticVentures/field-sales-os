/**
 * Expenses. Clock in/out with a break in minutes, and a photo drop zone that
 * auto-sorts odometer vs receipt vs statement. Ported from the NutriBiotic
 * OS (portfolio/src/app/nutribiotic/expenses/page.tsx). See
 * lib/shared/expenses.ts for the filing logic, ExpensesClient.tsx for the
 * form.
 */
import { ExpensesClient } from "./ExpensesClient";
import { LAUNCHERS } from "../../../lib/core/launchers";
import { PageHead } from "../../../lib/core/ui";

// Static: served from the CDN, gated by proxy, data loads through API
// routes that each check access.
export const dynamic = "force-static";

export const metadata = {
  title: "Expenses · Field Sales OS",
  appleWebApp: { title: "Expenses" },
  manifest: LAUNCHERS.EXPENSES.href,
};

export default function ExpensesPage() {
  return (
    <>
      <PageHead title="Expenses" />
      <ExpensesClient />
    </>
  );
}
