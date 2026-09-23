/**
 * The account context for one call, deliberately narrow: what the business
 * is, how to reach it, the headhunter's own contacts, the Angle (current
 * state / future state / impact), and the one most recent thing that
 * actually happened. Not the full account page, a call brief.
 *
 * Ported from the NutriBiotic OS's getSdrAccountPanel
 * (portfolio/src/app/nutribiotic/lib/sdr-actions.ts) as a GET route handler
 * rather than a Server Action, per PORTING.md. A GET, no idempotency key:
 * nothing here writes.
 */
import { hasAccess } from "../../../../../lib/core/devices";
import { getAccount, listActivities, listContacts, listPurchases, summarizePurchases } from "../../../../../lib/features/prospect/dal";

export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await hasAccess())) return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  const { id } = await params;

  const [account, contacts, activities, purchases] = await Promise.all([
    getAccount(id),
    listContacts(id),
    listActivities(id, 60),
    listPurchases(id),
  ]);
  if (!account) return Response.json({ ok: false, error: "Account not found." }, { status: 404 });

  return Response.json({
    ok: true,
    account: {
      id: account.id,
      name: account.name,
      channel: account.channel,
      area: account.area,
      street: account.street,
      city: account.city,
      state: account.state,
      postal: account.postal,
      lat: account.lat,
      lng: account.lng,
      phone: account.phone,
      website: account.website,
      lifecycle: account.lifecycle,
      leadStatus: account.lead_status,
      potentialJuan: account.potential_juan,
      readiness: account.readiness,
      quirks: account.quirks,
      currentState: account.current_state,
      futureState: account.future_state,
      impact: account.impact,
      lastOrderAt: account.last_order_at,
      lifetimeRevenue: account.lifetime_revenue,
      trailingRevenue: account.trailing_12m_revenue,
      expectedReorderAt: account.expected_reorder_at,
      purchases: summarizePurchases(purchases.orders, purchases.lines),
      businessHours: account.business_hours,
      hubspotCompanyId: account.hubspot_company_id,
      contacts: contacts.map((c) => ({
        id: c.id,
        name: [c.first_name, c.last_name].filter(Boolean).join(" ") || "Unnamed contact",
        title: c.title,
        phone: c.phone,
        email: c.email,
        isDecisionMaker: c.is_decision_maker,
      })),
      activities: activities.map((a) => ({ at: a.at, kind: a.kind, detail: a.detail })),
    },
  });
}
