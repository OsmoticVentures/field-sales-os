/**
 * What an account bought, summarized once for every screen that shows it
 * (the call panel's Main purchases, the client view's Purchases). Pure, so
 * the client view can run it in the browser.
 *
 * nb_orders holds the itemized ERP export, which starts in 2024; the card's
 * Lifetime value is HQ's all-time total. So the order count says the window
 * it covers ("2 orders since Nov 2024"), or the two read as a contradiction.
 * Literature riding along on an order (order forms, catalogs, at $0) is not
 * a purchase and is left out.
 */
export type PurchaseOrder = { id: string; ordered_at: string; revenue_cents: number };
export type PurchaseLine = { order_id: string; product_name: string | null; qty: number | null; line_revenue_cents: number; general_category?: string | null };

export type PurchaseSummaryItem = { name: string; qty: number; revenueCents: number; last3Qty: number; last: string | null };
export type PurchaseSummary = { orderCount: number; since: string | null; topItems: PurchaseSummaryItem[]; smallItems: PurchaseSummaryItem[] };

export function isLiterature(l: PurchaseLine): boolean {
  return (l.general_category ?? "").toLowerCase() === "literature" && l.line_revenue_cents === 0;
}

export function summarizePurchases(orders: PurchaseOrder[], lines: PurchaseLine[]): PurchaseSummary | null {
  if (orders.length === 0) return null;
  const byDate = [...orders].sort((a, b) => (a.ordered_at < b.ordered_at ? 1 : -1));
  const last3OrderIds = new Set(byDate.slice(0, 3).map((o) => o.id));
  const orderedAt = new Map(orders.map((o) => [o.id, o.ordered_at]));
  const totals = new Map<string, PurchaseSummaryItem>();
  for (const l of lines) {
    if (isLiterature(l)) continue;
    const name = l.product_name ?? "Item";
    const cur = totals.get(name) ?? { name, qty: 0, revenueCents: 0, last3Qty: 0, last: null };
    cur.qty += l.qty ?? 0;
    cur.revenueCents += l.line_revenue_cents;
    if (last3OrderIds.has(l.order_id)) cur.last3Qty += l.qty ?? 0;
    const at = orderedAt.get(l.order_id) ?? null;
    if (at && (!cur.last || at > cur.last)) cur.last = at;
    totals.set(name, cur);
  }
  const items = [...totals.values()].filter((t) => t.qty !== 0).sort((a, b) => b.qty - a.qty);
  return { orderCount: orders.length, since: byDate[byDate.length - 1]?.ordered_at ?? null, topItems: items.slice(0, 5), smallItems: items.slice(5) };
}

/** "2 orders since Nov 2024" */
export function orderWindowLabel(s: Pick<PurchaseSummary, "orderCount" | "since">): string {
  const n = `${s.orderCount} order${s.orderCount === 1 ? "" : "s"}`;
  if (!s.since) return n;
  const d = new Date(`${s.since.slice(0, 10)}T00:00:00`);
  return `${n} since ${d.toLocaleDateString("en-US", { month: "short", year: "numeric" })}`;
}
