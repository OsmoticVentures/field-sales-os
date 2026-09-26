/**
 * Shared shapes for the Route feature, ported from the NutriBiotic OS
 * (portfolio/src/app/nutribiotic/lib/dal.ts). Framework-free so both the
 * server dal and the client screen can import it.
 */

import type { Readiness } from "../prospect/priority";

export type Tier = "A" | "B" | "C" | "D" | "E" | "F" | "G";

/** Migration 0073's five funnel stages, mirrored from the NutriBiotic OS's
 *  nb_v_account_lead_stage. Values match the view exactly. */
export type LeadStage = "prospect" | "new_to_activate" | "active" | "dormant" | "closed";

/** lib/priority.ts's score for one account, computed server-side. Never
 *  null here: an id absent from priorityById is unscored, drawn as nothing. */
export type AccountPriority = { score: number; reason: string; band: "now" | "soon" | "later" | "unscored" };

/** Whether the map is currently showing chain/practice/prospect accounts.
 *  Persisted on nb_ui_prefs id=1, the same row the source app's map reads,
 *  so the preference follows Juan between this app and the source. */
export type MapDisplayPrefs = { showChains: boolean; showPractices: boolean; showProspects: boolean };

export type RouteEndpoint = { label: string; address: string; lat: number; lng: number };

export type RouteSchedulePrefs = {
  depart: string; // "09:30", local wall clock, no zone
  dwellMinutes: number;
  lunchMinutes: number;
};

export type CustomStopKind = "lunch" | "hotel" | "stop";

export const CUSTOM_STOP_LABEL: Record<CustomStopKind, string> = {
  lunch: "Lunch",
  hotel: "Hotel",
  stop: "Stop",
};

export type CustomStop = {
  /** Always prefixed "custom:", which is what tells the two apart in a draft. */
  id: string;
  kind: CustomStopKind;
  label: string;
  address: string;
  lat: number;
  lng: number;
};

/** One position in the route: an account id, or a stop that carries itself. */
export type RouteDraftEntry = string | CustomStop;

export type CallEntry = {
  id: string;
  label: string;
  phone: string;
  note?: string;
  accountId?: string;
};

export type RouteAccount = {
  id: string;
  name: string;
  street: string | null;
  city: string | null;
  state: string | null;
  lat: number;
  lng: number;
  phone: string | null;
  website: string | null;
  hubspot_company_id: string | null;
  tier: Tier | null;
  lifecycle: string;
  last_order_at: string | null;
  trailing_12m_revenue: number | null;
  lifetime_revenue: number | null;
  business_hours: Record<string, string[][]> | null;
  /** Everything below is additional to the Route feature's original slice,
   *  added to draw every account as a map pin with the source's filters and
   *  pin card (portfolio's map/AccountsMap.tsx, MapAccount type). */
  channel: string;
  area: string | null;
  /** HubSpot's own hs_lead_status mirror. Used only to keep Closed accounts
   *  off the map, same as the source. */
  lead_status: string | null;
  lead_stage: LeadStage | null;
  chain_excluded: boolean;
  practice_excluded: boolean;
  do_not_visit: boolean;
  readiness: Readiness | null;
};

export type RouteStopView = { id: string; lat: number; lng: number } & (
  | { type: "account"; account: RouteAccount }
  | { type: "custom"; custom: CustomStop }
);

export type DriveLeg = {
  /** Free-flow minutes scaled by the flat 1.35 factor. */
  minutes: number;
  /** OSRM's raw free-flow minutes, unscaled. */
  freeFlowMinutes: number;
  miles: number;
};
