/**
 * Compose and file one outbound draft for an account, from its own Gap
 * Selling summary or from a reason Juan typed. Ported from the NutriBiotic
 * OS's lib/account-actions.ts (draftAccountPitch, draftAccountPitchFromReason,
 * commit aa9730c/09843d7), called by this app's route handlers rather than
 * as Server Actions (PORTING.md: every write here is a route handler).
 *
 * Same grounding gate either way: composeAsk may only reword what the
 * account's current_state/future_state/impact, or the reason Juan typed,
 * already say. A missing recipient never blocks the draft itself, an
 * account with no email on file still gets a written draft, meant to be
 * pasted into the store's own website contact form, see mail-links.ts and
 * the Outbound screen's fallback.
 */
import "server-only";
import { getClientAccount, listClientContacts } from "../clients/dal";
import { asksCollide, composeAsk } from "./compose";
import { getVoiceContext, insertAskDraft, listAskKeys } from "./dal";

export type DraftAccountPitchResult =
  | { status: "drafted" }
  | { status: "already_queued" }
  | { status: "not_written"; reason: string };

async function loadAskInputs(accountId: string) {
  const [account, contactRows, alreadyFiled, voice] = await Promise.all([
    getClientAccount(accountId),
    listClientContacts(accountId),
    listAskKeys(accountId),
    getVoiceContext(accountId),
  ]);
  const contacts = contactRows
    .map((c) => ({
      id: c.id,
      name: [c.first_name, c.last_name].filter(Boolean).join(" ").trim(),
      title: c.title,
      email: c.email,
    }))
    .filter((c) => c.name);
  return { account, contacts, alreadyFiled, voice };
}

/**
 * The account profile's "Draft outreach" tap: compose straight from the
 * account's own Now/Opening/Impact summary, even when no customer has asked
 * for anything yet. An account with none of the three on file is refused
 * before a model is ever called rather than left to invent an opening.
 *
 * Idempotent the same way the source is: a second tap on an account that
 * already has this exact opening queued (dismissed or not) finds it via
 * asksCollide rather than filing a duplicate every time the profile reopens.
 */
export async function draftAccountPitch(accountId: string): Promise<DraftAccountPitchResult> {
  const { account, contacts, alreadyFiled, voice } = await loadAskInputs(accountId);
  if (!account) return { status: "not_written", reason: "Account not found." };

  const opening = account.future_state || account.impact || account.current_state;
  if (!opening) {
    return { status: "not_written", reason: "Nothing on file yet describes an opening for this account." };
  }
  if (alreadyFiled.some((r) => asksCollide(r.source_ask, opening))) {
    return { status: "already_queued" };
  }

  const noteText = [
    account.current_state ? `Now: ${account.current_state}` : null,
    account.future_state ? `Opening: ${account.future_state}` : null,
    account.impact ? `Impact: ${account.impact}` : null,
  ]
    .filter((v): v is string => Boolean(v))
    .join("\n\n");

  const composed = await composeAsk({
    ask: opening,
    noteText,
    account: { id: account.id, name: account.name, city: account.city, email: account.email },
    contacts,
    voice,
  });
  await insertAskDraft({ account_id: accountId, ask: opening, composed });

  return composed.written ? { status: "drafted" } : { status: "not_written", reason: composed.reason };
}

/**
 * The map's Suggested returns panel, and any other place with no Gap
 * Selling summary on file yet: takes Juan's own typed reason instead. Same
 * composer, same grounding gate, only the source text differs, this is not
 * a looser path.
 */
export async function draftAccountPitchFromReason(accountId: string, reason: string): Promise<DraftAccountPitchResult> {
  const trimmed = reason.trim();
  if (!trimmed) return { status: "not_written", reason: "No reason given." };

  const { account, contacts, alreadyFiled, voice } = await loadAskInputs(accountId);
  if (!account) return { status: "not_written", reason: "Account not found." };
  if (alreadyFiled.some((r) => asksCollide(r.source_ask, trimmed))) {
    return { status: "already_queued" };
  }

  const composed = await composeAsk({
    ask: trimmed,
    noteText: trimmed,
    account: { id: account.id, name: account.name, city: account.city, email: account.email },
    contacts,
    voice,
  });
  await insertAskDraft({ account_id: accountId, ask: trimmed, composed });

  return composed.written ? { status: "drafted" } : { status: "not_written", reason: composed.reason };
}
