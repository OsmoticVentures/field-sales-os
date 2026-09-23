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

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Expenses · Field Sales OS",
  appleWebApp: { title: "Expenses" },
  manifest: LAUNCHERS.EXPENSES.href,
};

export default function ExpensesPage() {
  return (
    <>
      <PageHead title="Expenses" sub="This pay period" />
      <ExpensesClient />
    </>
  );
}
