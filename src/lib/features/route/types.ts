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

/** Every day gets a Lunch stop, placed right after the first stop that ends
 *  between 11:30 and 2:30, unless it was taken off that day. */
export const LUNCH_FROM_MINUTES = 11 * 60 + 30;
export const LUNCH_UNTIL_MINUTES = 14 * 60 + 30;
/** The key in a day's stop times that records its Lunch stop was taken off,
 *  so the day doesn't put it back. No stop id looks like it. */
export const LUNCH_OFF = "lunch";
export const lunchDue = (leaveMinutes: number) => leaveMinutes >= LUNCH_FROM_MINUTES && leaveMinutes <= LUNCH_UNTIL_MINUTES;

export type CustomStopKind = "lunch" | "hotel" | "stop" | "event";

export const CUSTOM_STOP_LABEL: Record<CustomStopKind, string> = {
  lunch: "Lunch",
  hotel: "Hotel",
  stop: "Stop",
  event: "Calendar",
};

/** One Google Calendar event on a day, as calendar_to_route.py writes it to
 *  nb_ui_prefs.route_calendar. Times are LA wall clock; an all-day event has
 *  none. lat/lng only when its location resolved to a real place. */
export type CalendarEvent = {
  id: string;
  title: string;
  allDay: boolean;
  start?: string;
  end?: string;
  location?: string;
  address?: string;
  lat?: number;
  lng?: number;
};

/** A day's calendar events start inside this window to bend the route; the
 *  rest are listed only. */
export const CALENDAR_DAY_FROM = 7 * 60;
export const CALENDAR_DAY_UNTIL = 19 * 60;
/** A placeless event this long or shorter holds its time by default; a longer
 *  one reads as a planning block ("valley clients 2 to 5") and is listed only. */
export const CALENDAR_HOLD_MAX_MINUTES = 120;
/** The stop id a calendar event takes on the route, and the stop-times key
 *  that records Juan's choice for it ("off" = taken off the route, "hold" /
 *  "free" = a placeless event's time held or not). */
export const calendarStopId = (eventId: string) => `custom:cal:${eventId}`;
export const calendarChoiceKey = (eventId: string) => `cal:${eventId}`;

export type CustomStop = {
  /** Always prefixed "custom:", which is what tells the two apart in a draft. */
  id: string;
  kind: CustomStopKind;
  label: string;
  address: string;
  lat: number;
  lng: number;
  /** A lunch placed by the day itself, before a spot is picked: it sits at
   *  the stop before it and names that stop's area. */
  pending?: boolean;
  area?: string | null;
  phone?: string | null;
  /** A calendar event's stop: the event it came from and how long it runs. */
  calendarId?: string;
  minutes?: number;
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
  /** Where the row came from; "lead_scout" is a lead from the scout's list. */
  source?: string | null;
  /** The scout's own grade (A to E), not HQ potential. A to C is the New Indies list. */
  scout_grade?: string | null;
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
