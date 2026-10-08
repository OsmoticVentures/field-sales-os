/**
 * Record a touchpoint: Juan types what just happened, one schema-checked
 * model call turns it into structured field-sales data, and it files into
 * the OS and (when that feature's own write flag is "true") into HubSpot as a
 * Note/Call/Meeting. Ported from
 * portfolio/src/app/nutribiotic/lib/touchpoint.ts. The extraction prompt,
 * the tool schema, and the confidence threshold below are kept exactly, per
 * this milestone's instruction.
 *
 * NO FABRICATION (agency AGENTS.md principle 2): the extraction prompt is
 * instructed to pull only what the text actually states. Contact detail is
 * filled, never overwritten, so a bad parse can only add a blank field,
 * never clobber a true one.
 *
 * OUTREACH: every filed customer note goes to outbound/from-visit.ts, which
 * decides whether it leaves an email he owes and drafts it to the top of
 * Outbound (2026-10-07; the port had cut this and visits drafted nothing).
 *
 * SCOPE CUT FROM THE SOURCE (see the port's handback for the full list):
 * agency directives and the close-signal check (nb_close_signals) are extracted by the tool
 * schema exactly as the source asks (their fields still exist on
 * ParsedTouchpoint) but are not written anywhere by this port. The one
 * exception is the return-visit queue (2026-09-25): a stated "come back"
 * lands in nb_directives for nutribiotic-route-planner exactly as the
 * source writes it, since Route's Suggested returns is built from it. Account
 * facts (hours/phone/email) DO still land in the OS's nb_accounts, which
 * matches the deck's "corrected account facts" description; only the
 * further push of hours/phone to the HubSpot company record is cut, since
 * that needs hubspot-company.ts, not ported here.
 */
import "server-only";
import {
  applyAccountFacts,
  getAccount,
  insertActivity,
  insertContact,
  insertFieldNote,
  insertReturnDirectives,
  findFiledTouchpoint,
  insertTouchpoint,
  listAccountsForMatching,
  listContacts,
  patchContact,
  searchAccounts,
  type AccountCandidate,
  type AccountFactsReport,
  type Contact,
} from "./dal";
import { Blocked, isNeverFiledKind, runEngagement } from "./hubspot-engagement";
import { writeEnabled, type HubspotFeature } from "./hubspot";
import { draftFromVisit, type VisitOutbound } from "../outbound/from-visit";
import { ai, aiConfigured, AiError, hashInput } from "../../core/ai/client";
import { laDay, noteKey, once } from "../../core/once-server";
import { currentUser } from "../../core/user";
import { TouchpointSchema } from "./touchpoint-schema";

export type HubspotFilingReport = {
  hubspotFiled: boolean;
  hubspotNoteId: string | null;
  hubspotError: string | null;
};

/**
 * File the just-logged activity into HubSpot, gated on that feature's own
 * write flag (NB_HUBSPOT_VISIT_WRITE_ENABLED or NB_HUBSPOT_OUTBOUND_WRITE_ENABLED,
 * split 2026-09-28 so one can be on without the other). Defaults to "visit"
 * since that's Visit Logger's own flow; Outbound's mark-sent passes "outbound"
 * explicitly. When that feature's flag is off, this still builds the dry
 * preview (proves the body builder end to end) and returns
 * hubspotFiled:false with an explicit reason, rather than silently skipping
 * the step.
 */
export async function autoFileEngagement(activityId: number, feature: HubspotFeature = "visit"): Promise<HubspotFilingReport> {
  const enabled = writeEnabled(feature);
  try {
    const filed = await runEngagement(activityId, { write: enabled, feature });
    if (!enabled) {
      return { hubspotFiled: false, hubspotNoteId: null, hubspotError: "CRM filing off" };
    }
    return {
      hubspotFiled: filed.wrote || Boolean(filed.alreadyFiledId),
      hubspotNoteId: filed.noteId ?? filed.alreadyFiledId,
      hubspotError: null,
    };
  } catch (e) {
    return {
      hubspotFiled: false,
      hubspotNoteId: null,
      hubspotError: e instanceof Blocked ? e.message : "Not filed to HubSpot yet.",
    };
  }
}

type ParsedPerson = {
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  role_tag: "buyer" | "owner" | "manager" | "clerk" | "other" | null;
  is_decision_maker: boolean;
  email: string | null;
  phone: string | null;
  preferences: string | null;
};

/** File one parsed person against an account: update the existing contact,
 *  insert a new row otherwise. Matches by email first, then by name. */
export async function reconcileContact(accountId: string, existing: Contact[], p: ParsedPerson): Promise<"added" | "updated" | "none"> {
  const nameKey = (s: string | null) => (s ?? "").trim().toLowerCase();
  const emailKey = (s: string | null) => (s ?? "").trim().toLowerCase();
  const pEmail = emailKey(p.email);

  const digits = (s: string | null) => (s ?? "").replace(/\D/g, "").slice(-10);
  const pPhone = digits(p.phone);
  const pFirst = nameKey(p.first_name);
  const pLast = nameKey(p.last_name);
  // A later visit often adds the surname to a person first logged by first
  // name alone (or drops it); that is the same person, not a new row.
  const sameName = (c: Contact) =>
    nameKey(c.first_name) === pFirst &&
    (nameKey(c.last_name) === pLast || !nameKey(c.last_name) || !pLast);

  const match =
    (pEmail && existing.find((c) => emailKey(c.email) === pEmail)) ||
    (pPhone.length === 10 && existing.find((c) => digits(c.phone) === pPhone)) ||
    (pFirst || pLast ? existing.find((c) => (pFirst ? sameName(c) : nameKey(c.last_name) === pLast && !nameKey(c.first_name))) : undefined);

  if (match) {
    const patch: Record<string, string | boolean> = {};
    if (!match.first_name && p.first_name) patch.first_name = p.first_name;
    if (!match.last_name && p.last_name) patch.last_name = p.last_name;
    if (!match.title && p.title) patch.title = p.title;
    if (!match.role_tag && p.role_tag) patch.role_tag = p.role_tag;
    if (!match.email && p.email) patch.email = p.email;
    if (!match.phone && p.phone) patch.phone = p.phone;
    if (!match.is_decision_maker && p.is_decision_maker) patch.is_decision_maker = true;
    if (Object.keys(patch).length === 0) return "none";
    await patchContact(match.id, patch);
    return "updated";
  }

  if (!p.first_name && !p.last_name && !p.title) return "none";
  try {
    await insertContact({
      account_id: accountId,
      first_name: p.first_name,
      last_name: p.last_name,
      title: p.title,
      role_tag: p.role_tag,
      is_decision_maker: p.is_decision_maker,
      email: p.email,
      phone: p.phone,
    });
    return "added";
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('"code":"23505"')) return "none";
    throw e;
  }
}

type ParsedCalendarAction = {
  kind: "meeting" | "reminder" | "visit";
  title: string;
  when_iso: string | null;
  duration_minutes: number | null;
  notes: string | null;
  quote?: string | null;
};
type ParsedDirective = { directive: string; target: string | null; scope: "nutribiotic" | "agency" };
type ParsedOutreachAsk = { ask: string };
type ParsedAccountFacts = { business_hours: Record<string, string[][]> | null; phone: string | null; email: string | null };

export type ParsedTouchpoint = {
  account_id: string | null;
  account_confidence: "high" | "low" | "none";
  business_name_guess: string | null;
  activity: {
    kind: string;
    direction: "outbound" | "inbound" | "internal";
    outcome: string | null;
    detail: string;
    hubspot_summary: string;
  };
  people: ParsedPerson[];
  calendar_actions: ParsedCalendarAction[];
  account_facts: ParsedAccountFacts;
  next_step: string | null;
  directives?: ParsedDirective[];
  outreach_asks?: ParsedOutreachAsk[];
};

// ---------------------------------------------------------------------------
// EXTRACTION: the schema (./touchpoint-schema.ts) and system prompt, kept
// exactly (see file header). The prompt is split so the long stable part, the
// rules and the book's account list, is cached across notes, and only the
// reference time changes per call.
// ---------------------------------------------------------------------------

function systemPrompt(nowIso: string, candidates: AccountCandidate[]): { cached: string; tail: string } {
  // Sorted, so the same book renders the same bytes and the cache holds.
  const book = [...candidates].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    tail: `Reference time (America/Los_Angeles): ${nowIso}. Resolve every relative date/time ("Thursday", "next week", "in a month") against this reference.`,
    cached: `You extract structured field-sales data from one raw note a rep just typed about a store visit, call, or other touchpoint.

Candidate accounts (id · name · city), pick the single best match or null:
${book.map((c) => `${c.id} · ${c.name} · ${c.city ?? "unknown city"}`).join("\n")}

RULES, all absolute:
- Extract only what the text states or directly implies. Never invent a name, title, email, phone, date, or outcome that is not in the text.
- If the account is not clearly identifiable from the candidate list, set account_id to null and account_confidence to "none" rather than guessing.
- business_name_guess is the store/business name as the rep actually said it, verbatim, ALWAYS extracted when one was said, regardless of account_confidence. It is used to search for the business when it turns out to be new, so it must never be normalized, expanded, or guessed at when none was actually stated.
- activity.detail is what the rep said, kept in the rep's own first-person words ("I called...", not "The rep called..."). You may tidy filler, punctuation, and capitalization, and add light structure, but never rewrite it into third person, never paraphrase away his actual wording, and never drop a fact he stated.
- activity.hubspot_summary is what reaches the shared CRM another rep or HQ reads. It must match activity.detail's first-person voice and completeness: never third person, never "the rep," never "visited" with no subject, and never drop a fact, however small (an aside about where someone is from, what they said about themselves, etc). You may tighten redundant phrasing, but do not summarize facts away. Still never invent a name, number, date, or fact not in the text.
- Only include a person in "people" if the note actually names them or clearly describes a specific individual (a title alone like "the manager" with no name is still worth including with first_name/last_name null, if a real detail like an email or a stated preference is attached to them).
- role_tag is this person's relationship to the business, read from what the text actually calls them: "owner" only when the text states or clearly implies they own or run the store ("the store owner," "she's owned it 40 years," "his shop"); "manager" when called a manager or store lead; "clerk" for front-desk or counter staff with no stated authority; "buyer" ONLY when the text calls them the buyer or the one who places/decides orders and nothing stronger (owner/manager) is stated; "other" for a role that doesn't fit those, e.g. a vet or a bookkeeper; null when no role is stated at all. Never default to "buyer" as a guess, it is its own specific claim, not a fallback for "someone at this business." is_decision_maker is separate: whether they can approve buying, not which of these roles they hold.
- Only include a calendar_action if the note describes something that should go on a calendar (a scheduled meeting, an explicit follow-up date, a planned return visit). Do not invent a follow-up that was not mentioned.
- when_iso must be a real resolved timestamp if a specific day/time was stated; if only vague ("follow up soon") leave it null and say so in notes.
- FIRST, decide whether a customer was actually contacted. If nobody at a business was spoken to, walked in on, called, emailed or texted, activity.kind is "field_note" and direction is "internal". An observation about a storefront he only looked at or walked through, a thought about the market or the product line, a note to self about how the work should go, and an instruction to his own agency are ALL field notes. Do not reach for "visit", "call" or "meeting" because the note mentions a business name; a business named in passing is not a business contacted. A field note is never written to HubSpot, so hubspot_summary for one is short and plain, and it must never claim a contact happened ("I visited...", "I called...") when none did.
- Never set account_confidence to "high" on a field note unless the note is genuinely ABOUT that specific account (an observation about that store). A note to self that merely happens to mention a place is account_confidence "none" with account_id null. Attaching a note to self to a business is how a company gets created to receive it, which has already happened once and is what this kind exists to stop.
- directives carry instructions aimed at the agency, verbatim, and those same words must NOT appear in hubspot_summary. A note can be a real customer visit AND carry a directive; extract both. A note that is nothing but an instruction is a field_note whose detail is the instruction's own content.
- account_facts is for a fact about the BUSINESS as a whole, not a person: hours, a general store phone, a general ordering email. Only fill a field when the text states it about the store/office itself ("their hours are...", "the store's number is..."); a person's own phone or email belongs in people[], never here. Most visits state none of this, null is the normal answer.
- outreach_asks is for something the CUSTOMER asked for or was promised (pricing, a catalog, samples info, an order form), not something the rep decided to go do on his own, and not something the other side is going to send HIM. Only extract it when the text actually says the customer asked or was told something would be sent, by the rep. Do not put the same content in both outreach_asks and directives; directives are the rep's own instructions to his agency, outreach_asks are about the customer.
- next_step is a short, concrete statement of what happens with this account next, written so a different rep could act on it without rereading the note. Fill it whenever the text states or clearly implies a next action, INCLUDING an explicit "no follow-up" ("he said no", "nothing further, not interested", "all set for now"). The bar is that it NAMES the action: "bring a GSE sample Thursday", "call Maria back about case pricing", "email the catalog to the buyer". A vague "follow up", "check in", "touch base" or "circle back" with no stated object is NOT a next action, and is left null so the rep gets asked directly rather than shipped a line nobody can act on. Leave it null when the text is silent, or only that vague; the rep is asked one short question and answers in his own words, which is always better than a guess. Never invent a next step, and never turn a vague phrase into a specific-sounding one.`,
  };
}

// ---------------------------------------------------------------------------
// the flow
// ---------------------------------------------------------------------------

/** A filed note, or a note whose store could not be named with confidence.
 *  The second is NOT saved anywhere: the Visit screen picks the account on
 *  the spot and sends the same parse back with it, so a note is either filed
 *  or still on the screen, never parked. */
export type FiledTouchpoint = {
  ok: true;
  needsAccount: false;
  touchpoint_id: string;
  accountName: string | null;
  accountId: string | null;
  activityId: number | null;
  isFieldNote?: boolean;
  summary: string;
  peopleAdded: number;
  peopleUpdated: number;
  hubspotFiled: boolean;
  hubspotNoteId: string | null;
  hubspotError: string | null;
  accountFacts: AccountFactsReport | null;
  /** The email this visit left him owing, drafted to the top of Outbound. */
  outbound?: VisitOutbound;
};

export type RecordTouchpointResult =
  | FiledTouchpoint
  | {
      ok: true;
      needsAccount: true;
      summary: string;
      businessNameGuess: string | null;
      matchAccountId: string | null;
      matchAccountName: string | null;
      candidates: AccountCandidate[];
      parsed: ParsedTouchpoint;
    }
  | { ok: false; error: string };

/**
 * Each calendar action the note stated, as a pending route-planner row in
 * the source's exact `[follow-up:<kind>] <account>: <title> · ...` format,
 * which Route's Suggested returns parses back apart. Only what the note
 * stated: no time is "No time stated", never a guessed one.
 */
function returnVisitDirectiveRows(
  actions: ParsedCalendarAction[] | undefined,
  fieldNoteId: string | null,
  accountId: string | null,
  accountName: string | null,
): { field_note_id: string | null; directive: string; account_id: string | null }[] {
  return (actions ?? []).map((ca) => {
    const parts: string[] = [accountName ? `${accountName}: ${ca.title}` : ca.title];
    parts.push(ca.when_iso ? `Stated time: ${ca.when_iso}` : "No time stated");
    if (ca.duration_minutes) parts.push(`Stated duration: ${ca.duration_minutes} min`);
    if (ca.notes) parts.push(ca.notes);
    if (ca.quote) parts.push(`Quote: "${ca.quote}"`);
    return { field_note_id: fieldNoteId, directive: `[follow-up:${ca.kind}] ${parts.join(" · ")}`, account_id: accountId };
  });
}

export async function recordTouchpoint(
  rawText: string,
  accountIdHint?: string | null,
  opts: {
    kindOverride?: "meeting" | "call" | "email" | "field_note";
    forceNewAccount?: boolean;
    /** The parse from a first attempt that stopped to ask for the account:
     *  filing it with the picked account needs no second model call. */
    parsed?: ParsedTouchpoint | null;
  } = {},
): Promise<RecordTouchpointResult> {
  const text = rawText.trim();
  if (!text) return { ok: false, error: "Nothing to record." };

  const candidates = await listAccountsForMatching();
  if (candidates.length === 0) return { ok: false, error: "No accounts to match against yet." };

  if (opts.parsed && accountIdHint && isParsedTouchpoint(opts.parsed)) {
    return continueTouchpoint(text, opts.parsed, candidates, accountIdHint, opts);
  }
  if (!aiConfigured()) return { ok: false, error: "ANTHROPIC_API_KEY is not configured on this deployment." };

  const now = new Date();
  let parsed: ParsedTouchpoint;
  try {
    // Structured output against TouchpointSchema: a reply that does not
    // validate is retried once with the reason, then refused, never filed.
    const { data } = await ai({
      task: "touchpoint_extract",
      system: systemPrompt(now.toISOString(), candidates),
      messages: [{ role: "user", content: text }],
      schema: TouchpointSchema,
    });
    parsed = data;
  } catch (err) {
    if (err instanceof AiError && err.kind === "invalid") return { ok: false, error: "Could not read that note. Try again." };
    return { ok: false, error: `Could not read that note: ${err instanceof Error ? err.message : String(err)}` };
  }

  return continueTouchpoint(text, parsed, candidates, accountIdHint, opts);
}

async function continueTouchpoint(
  text: string,
  parsed: ParsedTouchpoint,
  candidates: AccountCandidate[],
  accountIdHint: string | null | undefined,
  opts: { kindOverride?: "meeting" | "call" | "email" | "field_note"; forceNewAccount?: boolean },
): Promise<RecordTouchpointResult> {
  if (opts.kindOverride) {
    parsed.activity.kind = opts.kindOverride === "email" ? "email_out" : opts.kindOverride;
  }

  // A FIELD NOTE NEVER TOUCHES AN ACTIVITY, AN ACCOUNT IT WAS NOT ABOUT, OR HUBSPOT.
  if (parsed.activity.kind === "field_note") {
    const noteAccountId = accountIdHint || (parsed.account_confidence === "high" ? parsed.account_id : null);
    const noteAccount = candidates.find((a) => a.id === noteAccountId);

    // Once per rep, store, note and day: a double tap or a retry with a new
    // header files one field note, and the second caller gets the first's result.
    const actor = await currentUser().then((u) => u.id).catch(() => "unknown");
    const key = `fieldnote:${hashInput(actor, noteAccountId ?? "", noteKey(text), laDay())}`;
    const { result } = await once(key, async (): Promise<FiledTouchpoint> => {
      const tp = await insertTouchpoint({
        account_id: noteAccountId ?? null,
        raw_text: text,
        status: "parsed",
        account_match_confidence: accountIdHint ? "high" : parsed.account_confidence,
        parsed,
      });
      const fieldNote = await insertFieldNote({
        account_id: noteAccountId ?? null,
        touchpoint_id: tp.id,
        detail: parsed.activity.detail,
        raw_text: text,
      });
      await insertReturnDirectives(
        returnVisitDirectiveRows(parsed.calendar_actions, fieldNote?.id ?? null, noteAccountId ?? null, noteAccount?.name ?? null),
      );

      return {
        ok: true,
        touchpoint_id: tp.id,
        accountName: noteAccount?.name ?? null,
        accountId: noteAccount?.id ?? null,
        activityId: null,
        needsAccount: false,
        isFieldNote: true,
        summary: parsed.activity.detail,
        peopleAdded: 0,
        peopleUpdated: 0,
        hubspotFiled: false,
        hubspotNoteId: null,
        hubspotError: null,
        accountFacts: null,
      };
    });
    return result;
  }

  const accountId = opts.forceNewAccount ? null : accountIdHint || (parsed.account_confidence === "high" ? parsed.account_id : null);

  if (!accountId) {
    const matchAccount =
      !opts.forceNewAccount && parsed.account_confidence === "low" && parsed.account_id
        ? candidates.find((a) => a.id === parsed.account_id)
        : null;
    const guess = parsed.business_name_guess?.trim() || null;
    const found = guess && !opts.forceNewAccount ? await searchAccounts(guess).catch(() => []) : [];
    return {
      ok: true,
      needsAccount: true,
      summary: parsed.activity?.detail ?? text.slice(0, 140),
      businessNameGuess: guess,
      matchAccountId: matchAccount?.id ?? null,
      matchAccountName: matchAccount?.name ?? null,
      candidates: found.filter((c) => c.id !== matchAccount?.id).slice(0, 5),
      parsed,
    };
  }

  const account = candidates.find((a) => a.id === accountId) ?? (await getAccount(accountId).catch(() => null));
  if (!account) return { ok: false, error: "That account is not in your book." };
  const accountName = account.name ?? null;

  // A note with no stated next step files as it is. The next step is part
  // of the record when he said one, never a reason to hold the note back.
  return finishTouchpoint({
    accountId,
    accountName,
    parsed,
    rawText: text,
    accountMatchConfidence: accountIdHint ? "high" : parsed.account_confidence,
  });
}

type FinishInput = {
  accountId: string;
  accountName: string | null;
  parsed: ParsedTouchpoint;
  rawText: string;
  accountMatchConfidence: string | null;
};

/**
 * Once per rep, account, note and day (core/once.ts). The route's own
 * Idempotency-Key covers a retry of one tap; this covers two taps that each
 * minted a key, a phone retry racing its own first try, and two server
 * instances: one activity, one HubSpot record, one outbound draft. The
 * second caller gets the first caller's result; if that one did not reach
 * HubSpot, the HubSpot filing (deduped per activity) is tried again here.
 */
async function finishTouchpoint(input: FinishInput): Promise<FiledTouchpoint> {
  const actor = await currentUser().then((u) => u.id).catch(() => "unknown");
  const key = `touchpoint:${hashInput(actor, input.accountId, noteKey(input.rawText), laDay())}`;
  const { result, replayed } = await once(key, () => fileTouchpoint(input));
  if (replayed && result.activityId && !result.hubspotFiled && !isNeverFiledKind(input.parsed.activity.kind)) {
    return { ...result, ...(await autoFileEngagement(result.activityId)) };
  }
  return result;
}

async function fileTouchpoint(input: FinishInput): Promise<FiledTouchpoint> {
  const { accountId, accountName, parsed } = input;

  // A retry of a note whose first try got as far as its touchpoint row: the
  // note is already in, so only the HubSpot filing (which dedupes its own
  // note) is run again. Never a second activity.
  const earlier = await findFiledTouchpoint(accountId, input.rawText).catch(() => null);
  if (earlier?.activity_id) {
    const [hubspot, outbound] = await Promise.all([
      isNeverFiledKind(parsed.activity.kind)
        ? ({ hubspotFiled: false, hubspotNoteId: null, hubspotError: null } satisfies HubspotFilingReport)
        : autoFileEngagement(earlier.activity_id),
      draftFromVisit(visitNote(earlier.id, accountId, input.rawText, parsed)),
    ]);
    return {
      ok: true,
      touchpoint_id: earlier.id,
      accountName,
      accountId,
      activityId: earlier.activity_id,
      needsAccount: false,
      summary: parsed.activity.detail,
      peopleAdded: 0,
      peopleUpdated: 0,
      ...hubspot,
      accountFacts: null,
      outbound,
    };
  }

  const activity = await insertActivity({
    account_id: accountId,
    kind: parsed.activity.kind,
    direction: parsed.activity.direction,
    outcome: parsed.activity.outcome,
    detail: parsed.activity.detail,
  });

  let accountFacts: AccountFactsReport | null = null;
  try {
    accountFacts = await applyAccountFacts(accountId, parsed.account_facts);
    const oldVersionLines: string[] = [];
    if (accountFacts.business_hours?.status === "updated") oldVersionLines.push(`Old version (business hours) was on file.`);
    if (accountFacts.phone?.status === "updated") oldVersionLines.push(`Old version (phone): ${accountFacts.phone.old}`);
    if (accountFacts.email?.status === "updated") oldVersionLines.push(`Old version (email): ${accountFacts.email.old}`);
    if (oldVersionLines.length > 0) {
      parsed.activity.hubspot_summary = `${parsed.activity.hubspot_summary}\n\n${oldVersionLines.join("\n")}`;
    }
  } catch {
    accountFacts = null;
  }

  const existing = await listContacts(accountId);
  let peopleAdded = 0;
  let peopleUpdated = 0;
  for (const p of parsed.people ?? []) {
    // The activity is already written: a contact that fails to save must not
    // fail the note, or its retry would write the activity twice.
    const outcome = await reconcileContact(accountId, existing, p).catch(() => "none" as const);
    if (outcome === "added") peopleAdded += 1;
    else if (outcome === "updated") peopleUpdated += 1;
  }

  // The touchpoint row is what marks this note as filed for a retry, so one
  // more try here before a failure is allowed to escape.
  const touchpointRow = {
    account_id: accountId,
    raw_text: input.rawText,
    status: "parsed",
    account_match_confidence: input.accountMatchConfidence,
    activity_id: activity.id,
    parsed,
  };
  const tp = await insertTouchpoint(touchpointRow).catch(() => insertTouchpoint(touchpointRow));

  await insertReturnDirectives(returnVisitDirectiveRows(parsed.calendar_actions, null, accountId, accountName)).catch(() => {});

  // The email the visit left owing is decided and drafted beside HubSpot,
  // not after it, so the note files no slower than the slower of the two.
  const [hubspot, outbound] = await Promise.all([
    isNeverFiledKind(parsed.activity.kind)
      ? ({ hubspotFiled: false, hubspotNoteId: null, hubspotError: null } satisfies HubspotFilingReport)
      : autoFileEngagement(activity.id),
    draftFromVisit(visitNote(tp.id, accountId, input.rawText, parsed)),
  ]);

  return {
    ok: true,
    touchpoint_id: tp.id,
    accountName,
    accountId,
    activityId: activity.id,
    needsAccount: false,
    summary: parsed.activity.detail,
    peopleAdded,
    peopleUpdated,
    ...hubspot,
    accountFacts,
    outbound,
  };
}

function visitNote(touchpointId: string, accountId: string, rawText: string, parsed: ParsedTouchpoint) {
  return {
    touchpointId,
    accountId,
    rawText,
    kind: parsed.activity.kind,
    nextStep: parsed.next_step ?? null,
    outreachAsks: (parsed.outreach_asks ?? []).map((a) => a.ask?.trim()).filter((a): a is string => Boolean(a)),
  };
}

/** The tool output is data from a model: check the shape the flow relies on
 *  before trusting it, and the same for a parse the Visit screen sends back. */
export function isParsedTouchpoint(v: unknown): v is ParsedTouchpoint {
  if (!v || typeof v !== "object") return false;
  const p = v as Partial<ParsedTouchpoint>;
  const a = p.activity as Partial<ParsedTouchpoint["activity"]> | undefined;
  if (!a || typeof a !== "object") return false;
  if (typeof a.kind !== "string" || typeof a.detail !== "string" || typeof a.hubspot_summary !== "string") return false;
  if (typeof a.direction !== "string") return false;
  if (p.people !== undefined && !Array.isArray(p.people)) return false;
  if (p.calendar_actions !== undefined && !Array.isArray(p.calendar_actions)) return false;
  return true;
}
