/**
 * "Use this day": takes one day exactly as Juan reviewed it in Plan week and
 * writes it onto his live map (nb_ui_prefs.route_draft), the same column
 * `/route`'s hand-built draft already lives in. Never a calendar write; a
 * day only becomes real once he taps it, same as tapping a pin by hand.
 *
 * NEVER CLOBBERS SILENTLY. A day that already has stops on it (hand-built,
 * or from an earlier Plan week run) is never overwritten without Juan's own
 * choice: with no `mode`, this reports a conflict and writes nothing; the
 * caller re-sends with `mode: "replace"` or `mode: "add"` once he's picked.
 *
 * SCOPE, asserted the same way route_draft_write.py asserts it: every
 * account id is looked up in Juan's owned, geocoded book and must resolve
 * there before anything is written. An id that doesn't resolve is rejected
 * with a reason, never silently dropped from the day.
 */
import "server-only";
import { getRouteStateByDay, listOwnerAccounts, resolveDirective, setRouteDraft } from "../route/dal";
import type { RouteDraftEntry } from "../route/types";

export type UseDayResult =
  | { status: "ok"; draft: Record<string, RouteDraftEntry[]> }
  | { status: "conflict"; existingCount: number }
  | { status: "error"; error: string };

export async function useDay(input: {
  date: string;
  accountIds: string[];
  directiveIds: string[];
  mode?: "replace" | "add";
}): Promise<UseDayResult> {
  const { date, directiveIds, mode } = input;
  const accountIds = [...new Set(input.accountIds)];

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { status: "error", error: "date must be YYYY-MM-DD." };
  if (accountIds.length === 0) return { status: "error", error: "No stops to use." };

  const owned = new Map((await listOwnerAccounts()).map((a) => [a.id, a]));
  const unknown = accountIds.filter((id) => !owned.has(id));
  if (unknown.length > 0) {
    return { status: "error", error: `Not in your owned, geocoded book, can't add: ${unknown.join(", ")}` };
  }

  const state = await getRouteStateByDay();
  const existing = state.draft[date] ?? [];
  const existingIds = new Set(existing.filter((e): e is string => typeof e === "string"));
  const existingCount = existing.length;

  if (existingCount > 0 && !mode) {
    return { status: "conflict", existingCount };
  }

  const nextEntries: RouteDraftEntry[] =
    mode === "add" ? [...existing, ...accountIds.filter((id) => !existingIds.has(id))] : [...accountIds];

  const nextDraft = { ...state.draft, [date]: nextEntries };
  await setRouteDraft(nextDraft);

  // Placing a directive's account on a used day resolves that directive
  // (nutribiotic-route-planner's own rule); a resolve failure never
  // unwinds the draft write that already succeeded, it's logged by the
  // caller's error handling as a partial result, not retried blind.
  for (const id of directiveIds) {
    await resolveDirective(id, `placed on route ${date}`);
  }

  return { status: "ok", draft: nextDraft };
}
