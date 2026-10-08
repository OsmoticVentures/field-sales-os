// Synthetic rows for fake-postgrest.mjs, sized to the real book so byte
// counts are comparable: Juan ~452 open accounts, Kyle a smaller NorCal book,
// the rest unowned (search finds, closed, other reps), ~1,100 accounts in all.
// Deterministic: the same seed every run, so before/after numbers compare.
// No real names, numbers or addresses; nothing here is customer data.

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

const OWNERS = [
  { owner: "36242368", n: 470 }, // Juan: ~452 open after closed/chain/waypoint
  { owner: "35219013", n: 330 }, // Kyle
  { owner: null, n: 300 }, // unowned / other
];
const AREAS = Array.from({ length: 12 }, (_, i) => ({ id: `area_${i}`, label: `Area ${i}`, color: `#3${i}6A46`, display_order: i, account_count: 40 }));
const LIFE = ["active", "dormant", "prospect", "lost", "active", "prospect"];
const KINDS = ["visit", "call", "email", "note", "meeting", "sample"];
const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

export function seed() {
  const r = rng(42);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const date = (daysBack) => new Date(Date.UTC(2026, 9, 8) - Math.floor(r() * daysBack) * 86_400_000).toISOString().slice(0, 10);
  const words = (n) => Array.from({ length: n }, () => pick(["store", "owner", "shelf", "reorder", "sample", "GSE", "nasal", "spray", "buyer", "Tuesday", "liked", "wants", "follow", "up", "price", "display"])).join(" ");

  const accounts = [];
  let k = 0;
  for (const { owner, n } of OWNERS) {
    for (let i = 0; i < n; i++, k++) {
      const id = `a_${k.toString(16).padStart(6, "0")}`;
      const hours = r() < 0.7 ? Object.fromEntries(DAYS.slice(0, 6).map((d) => [d, [["09:00", "19:00"]]])) : null;
      accounts.push({
        id, name: `Account ${k} ${words(2)}`, dba: null, channel: pick(["retail", "practice", "online"]),
        street: `${100 + k} Main St`, city: pick(["Irvine", "Costa Mesa", "San Diego", "Oakland", "Fresno"]), state: "CA", postal: `9${String(k).padStart(4, "0")}`,
        lat: 33 + r() * 5, lng: -118 - r() * 4, phone: `+1949555${String(k).padStart(4, "0")}`, website: `https://example${k}.test`,
        hubspot_company_id: r() < 0.8 ? String(1e10 + k) : null, hubspot_owner_id: owner, owner_name: owner ? "Rep" : null,
        lifecycle: k === 0 ? "waypoint" : pick(LIFE), first_order_at: date(2000), last_order_at: r() < 0.6 ? date(900) : null,
        lifetime_revenue: Math.round(r() * 40000), trailing_12m_revenue: Math.round(r() * 8000), expected_reorder_days: 60, expected_reorder_at: date(30),
        business_hours: hours, timezone: "America/Los_Angeles", quirks: r() < 0.3 ? words(12) : null,
        current_state: r() < 0.3 ? words(25) : null, future_state: r() < 0.3 ? words(25) : null, impact: r() < 0.3 ? words(20) : null,
        do_not_visit: false, enrichment_status: { website: "done", places: "done", hours: "places" }, dirty_fields: {},
        origin: pick(["erp", "hubspot", "search"]), synthetic_dataset_id: null, created_at: "2026-06-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
        email: r() < 0.5 ? `buyer${k}@example.test` : null, instagram_url: null, facebook_url: null, linkedin_url: null,
        erp_customer_code: `C${k}`, erp_customer_type: "retail", retail_mode: "independent", store_type: pick(["health_food", "pharmacy", "grocery"]),
        locations_count: 1, employees_est: 8, annual_revenue_usd: null, alternates: [], area: pick(AREAS).id,
        chain_excluded: r() < 0.05, chain_excluded_at: null, practice_excluded: r() < 0.05, practice_excluded_at: null,
        closed_at: r() < 0.04 ? "2026-05-01T00:00:00Z" : null, closed_reason: null, lead_status: pick(["Open", "Attempted", "Connected", null]),
        potential_juan: r() < 0.1 ? pick(["A", "B", "C"]) : null, potential_hq: r() < 0.3 ? "B Store" : null, hubspot_sync_eligible: true,
        source: "erp", source_external_id: null, source_pulled_at: null, readiness: r() < 0.3 ? pick(["hot", "normal", "cold"]) : null, readiness_set_at: null,
        shelf_units: r() < 0.3 ? 4 : null, supp_body_pct: null, employee_count: r() < 0.3 ? 6 : null, stores_per_decision_maker: r() < 0.3 ? 1 : null,
        tier_synced: null, places_status: "OPERATIONAL", places_rating_count: Math.floor(r() * 300), hours_source_tier: "places",
      });
    }
  }

  const potential = accounts.map((a) => ({ account_id: a.id, name: a.name, potential: Math.round(r() * 100), potential_grade: pick(["A", "B", "C", "D", null]) }));
  const leadStage = accounts.map((a) => ({ account_id: a.id, touchpoints: Math.floor(r() * 9), last_revenue_on: a.last_order_at, lead_stage: pick(["active", "dormant", "prospect", "new_to_activate"]) }));
  const tierById = new Map(potential.map((p) => [p.account_id, p.potential_grade]));
  const tier = accounts.map((a) => ({
    account_id: a.id, name: a.name, lifecycle: a.lifecycle, fit: Math.round(r() * 100), fit_confidence: r(), fit_inputs_known: 2, fit_inputs_total: 4,
    engagement: Math.round(r() * 100), origin: a.origin, tier: tierById.get(a.id) ?? "D", area: a.area, hubspot_owner_id: a.hubspot_owner_id,
    chain_excluded: a.chain_excluded, practice_excluded: a.practice_excluded, closed_at: a.closed_at,
  }));

  const orders = [];
  const lines = [];
  for (let i = 0; i < 3200; i++) {
    const a = pick(accounts.slice(1));
    orders.push({ id: i + 1, account_id: a.id, ordered_at: date(1400), revenue_cents: Math.round(r() * 90000) });
    for (let j = 0; j < 2; j++) lines.push({ order_id: i + 1, account_id: a.id, product_name: pick(["GSE Liquid", "Nasal Spray", "Ear Drops", "Skin Cleanser"]), qty: 6, line_revenue_cents: 5000 });
  }
  const acts = [];
  for (let i = 0; i < 2600; i++) {
    const a = pick(accounts.slice(1));
    const kind = pick(KINDS);
    acts.push({ id: i + 1, account_id: a.id, contact_id: null, at: `${date(500)}T17:00:00Z`, logged_at: null, kind, effective_kind: kind, direction: pick(["outbound", "inbound", "internal"]),
      outcome: pick(["connected", "declined", null]), detail: words(18 + Math.floor(r() * 30)), origin: pick(["app", "hubspot", "enriched"]), retracted: false, corrected: false, hubspot_engagement_id: null });
  }
  const contacts = accounts.slice(1).flatMap((a, i) => (i % 2 ? [] : [{ id: `c_${i}`, account_id: a.id, first_name: "Pat", last_name: `Lee${i}`, title: "Buyer", role_tag: null, is_decision_maker: i % 4 === 0, email: null, phone: null, linkedin_url: null }]));
  const deals = accounts.slice(1, 160).map((a, i) => ({ id: `d_${i}`, account_id: a.id, stage: pick(["identified", "contacted", "discovery", "sampled", "trial", "stocked", "reordered"]), next_step: words(5), next_step_date: date(60), origin: "app" }));
  const stale = deals.slice(0, 70).map((d) => ({ deal_id: d.id, account_id: d.account_id, account_name: "Account", stage: d.stage, next_step: d.next_step, next_step_date: d.next_step_date, next_step_days_overdue: 9, last_activity_at: null, days_since_activity: 30, tier: "C", origin: "app" }));

  return {
    nb_users: [
      { id: "juan", name: "Juan", hubspot_owner_id: "36242368", owner_name: "Juan", pin_salt: "x", pin_hash: "x", prefs_id: 1, features: null, disabled_at: null },
      { id: "kyle", name: "Kyle", hubspot_owner_id: "35219013", owner_name: "Kyle", pin_salt: "y", pin_hash: "y", prefs_id: 2, features: null, disabled_at: null },
    ],
    nb_devices: [],
    nb_accounts: accounts,
    nb_v_account_potential: potential,
    nb_v_account_lead_stage: leadStage,
    nb_v_account_tier: tier,
    nb_v_fit_metrics: [],
    nb_orders: orders,
    nb_order_lines: lines,
    nb_activities: acts,
    nb_v_activities_effective: acts,
    nb_field_notes: [],
    nb_order_emails: accounts.slice(1, 120).map((a, i) => ({ id: i, account_id: a.id, no_charge: false })),
    nb_outbound_drafts: accounts.slice(1, 40).map((a, i) => ({ id: `od_${i}`, account_id: a.id, status: "pending", urgency: 3, urgency_reason: "due", subject: "Hello", body: words(60), created_at: "2026-10-01T00:00:00Z" })),
    nb_contacts: contacts,
    nb_deals: deals,
    nb_v_pipeline_stale: stale,
    nb_territory_areas: AREAS,
    nb_ui_prefs: [
      { id: 1, route_draft: { "2026-10-08": accounts.slice(1, 9).map((a) => a.id) }, route_calls: {}, route_done: {}, route_stop_times: {}, route_start: {}, route_end: {}, route_depart: "09:30:00", route_dwell_minutes: 20, route_lunch_minutes: 30, show_chain_accounts: false, show_practice_accounts: false, show_prospect_accounts: false },
      { id: 2, route_draft: {}, route_calls: {}, route_done: {}, route_stop_times: {}, route_start: {}, route_end: {} },
    ],
    nb_sdr_schedule: accounts.slice(1, 50).map((a, i) => ({ id: `s_${i}`, account_id: a.id, kind: "call", scheduled_date: "2026-10-09", status: "pending", priority: 1, created_at: "2026-10-01T00:00:00Z", prospect_name: null, prospect_phone: null })),
    nb_directives: accounts.slice(1, 25).map((a, i) => ({ id: `dir_${i}`, account_id: a.id, directive: `[follow-up:2026-10-10] ${words(6)}`, status: "pending", created_at: "2026-10-01T00:00:00Z" })),
    nb_report_drafts: [],
    nb_v_report_metrics_alltime: ["visits", "touchpoints", "miles", "day_worked"].map((m) => ({ metric: m, total: 100, through_date: "2026-10-07", user_id: "juan" })),
    nb_touchpoints: [],
    nb_idempotency_keys: [],
    nb_search_jobs: [], nb_search_groups: [], nb_search_group_members: [], nb_search_hidden: [], nb_search_exclusions: [], nb_places_search: [],
    nb_me: [], nb_score_configs: [],
  };
}
