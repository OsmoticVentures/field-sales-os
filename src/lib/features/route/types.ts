/**
 * Shared shapes for the Route feature, ported from the NutriBiotic OS
 * (portfolio/src/app/nutribiotic/lib/dal.ts). Framework-free so both the
 * server dal and the client screen can import it.
 */

export type Tier = "A" | "B" | "C" | "D" | "E" | "F" | "G";

export type RouteEndpoint = { label: string; address: string; lat: number; lng: number };

export type RouteSchedulePrefs = {
  depart: string; // "09:30", local wall clock, no zone
  dwellMinutes: number;
  lunchMinutes: number;
  returnBy: string | null;
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
  lead_stage: string | null;
  lifecycle: string;
  last_order_at: string | null;
  trailing_12m_revenue: number | null;
  lifetime_revenue: number | null;
  business_hours: Record<string, string[][]> | null;
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
