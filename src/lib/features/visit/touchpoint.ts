/**
 * Record a touchpoint: Juan types what just happened, one forced-tool-schema
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
 * SCOPE CUT FROM THE SOURCE (see the port's handback for the full list):
 * agency directives, outreach asks (nb_outbound_drafts, ask-compose.ts),
 * and the close-signal check (nb_close_signals) are extracted by the tool
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
import Anthropic from "@anthropic-ai/sdk";
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

const client = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

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
// EXTRACTION: tool schema and system prompt, kept exactly (see file header)
// ---------------------------------------------------------------------------

const EXTRACT_TOOL = {
  name: "extract_touchpoint",
  description: "Extract structured field-sales data from a rep's raw note about one account visit/call/interaction.",
  input_schema: {
    type: "object" as const,
    properties: {
      account_id: {
        type: ["string", "null"],
        description: "id of the best-matching account from the candidate list, or null if no confident match",
      },
      account_confidence: { type: "string", enum: ["high", "low", "none"] },
      business_name_guess: {
        type: ["string", "null"],
        description: "the business/store name AS STATED in the note, verbatim, even when account_confidence is low or none. Null only if no business name was said at all.",
      },
      activity: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: [
              "visit", "call", "text", "email_out", "email_in", "linkedin",
              "newsletter", "meeting", "note", "order", "sample_drop", "staff_training",
              "field_note",
            ],
            description: "An in-person stop at a store or office, walked in or dropped by, is 'visit', even when the rep talks to or 'meets with' someone while there. Use 'meeting' only when the text itself frames it as a scheduled, formal meeting or appointment, not just a conversation that happened in person. This is what titles the HubSpot record ('Visit' vs 'Meeting'), and almost everything a rep dictates from the field is a visit. 'field_note' is the one kind that is NOT a customer contact: no store was called, walked into, emailed or texted. It covers an observation about a market or a storefront the rep only looked at, a note to self about how the work should go, and an instruction aimed at his own agency. A field note never reaches HubSpot, so choosing it wrongly hides real customer contact, and choosing anything else for a note to self invents a customer contact that never happened.",
          },
          direction: { type: "string", enum: ["outbound", "inbound", "internal"] },
          outcome: {
            type: ["string", "null"],
            enum: ["reached", "no_decision_maker", "closed", "declined", "reschedule", "no_answer", "left_sample", null],
            description: "Use 'closed' only when the text says the BUSINESS ITSELF has shut down for good (out of business, permanently closed, the space is empty or another business is in it). Not for a deal being closed or won, and not for a store that merely happened to be closed at the time the rep stopped by, which is 'no_answer'.",
          },
          detail: {
            type: "string",
            description: "what the rep said, kept in the rep's own first-person words ('I called...', not 'The rep called...'). Trim filler words and clean up punctuation/capitalization/structure, but never paraphrase into third person and never drop a stated fact. This is the full record kept in the OS, not what gets written to HubSpot.",
          },
          hubspot_summary: {
            type: "string",
            description: "For the shared HubSpot record. Same first-person voice as detail ('I visited...', never 'Visited...' or 'The rep...') and the same no-fabrication rule. You may tighten repetition and filler words for readability, but never drop a fact the rep stated, including small color like where someone is from or what they said about themselves. This is not a shorter, lossier version of detail; it is the same account, in the rep's voice, cleaned up.",
          },
        },
        required: ["kind", "direction", "detail", "hubspot_summary"],
      },
      people: {
        type: "array",
        items: {
          type: "object",
          properties: {
            first_name: { type: ["string", "null"] },
            last_name: { type: ["string", "null"] },
            title: { type: ["string", "null"] },
            role_tag: {
              type: ["string", "null"],
              enum: ["buyer", "owner", "manager", "clerk", "other", null],
              description: "What the text actually calls this person, not a default. 'owner' requires the text to say or clearly imply they own/run the store. 'buyer' means they were called the buyer or place/decide orders, never a fallback guess for an unspecified role. Null when no role is stated.",
            },
            is_decision_maker: { type: "boolean" },
            email: { type: ["string", "null"] },
            phone: { type: ["string", "null"] },
            preferences: {
              type: ["string", "null"],
              description: "communication or relationship preference literally stated, e.g. 'prefers texts after 2pm'",
            },
          },
          required: ["is_decision_maker"],
        },
      },
      calendar_actions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["meeting", "reminder", "visit"] },
            title: { type: "string" },
            when_iso: {
              type: ["string", "null"],
              description: "resolved absolute RFC3339 datetime with America/Los_Angeles offset, or null if no time was stated",
            },
            duration_minutes: { type: ["integer", "null"] },
            notes: { type: ["string", "null"] },
            quote: {
              type: ["string", "null"],
              description: "The exact short clause or sentence, copied verbatim from the note, that states the return ask (e.g. \"come back next Friday\"). Not a paraphrase or a summary, the rep's own words only. Null if the note never states one as a distinct phrase.",
            },
          },
          required: ["kind", "title"],
        },
      },
      directives: {
        type: "array",
        description: "Instructions the rep aimed at his own agency rather than content about a customer: 'go find their email from the website', 'build me an agent that...', 'draft an action plan and put it on my desktop'. An instruction inside a dictated note is not content for the note. Extract each one verbatim. Empty array is the normal answer; most notes carry none.",
        items: {
          type: "object",
          properties: {
            directive: {
              type: "string",
              description: "the instruction as the rep said it, verbatim, lightly cleaned for filler only. Never re-worded into a task title.",
            },
            target: {
              type: ["string", "null"],
              description: "who should act, when the text makes it obvious: 'nutribiotic-enricher' (find a missing website/phone/decision maker), 'nutribiotic-route-planner' (go back, go see, plan a day), 'nutribiotic-account-analyst' (who is overdue, what do they buy, scoring), 'head-nutribiotic' (the sales OS itself), 'agent-maker' (build a new agent), 'head-pm' (plan a project). Null when it is not clear.",
            },
            scope: {
              type: "string",
              enum: ["nutribiotic", "agency"],
              description: "'nutribiotic' when it is about this territory, its accounts, or this sales OS. 'agency' when it is about Juan's wider operation.",
            },
          },
          required: ["directive", "scope"],
        },
      },
      outreach_asks: {
        type: "array",
        description: "Something the customer explicitly asked to be sent, or was promised, by email: pricing, a catalog, product/samples info, an order form, being added to a mailing list. Extract only when the text says the CUSTOMER asked for or was promised something to follow up on, in the rep's own words. IT MUST BE SOMETHING THE REP SENDS THEM. A thing the other side will send HIM is not an outreach ask however real it is. Empty array is the normal answer; most notes carry none.",
        items: {
          type: "object",
          properties: {
            ask: {
              type: "string",
              description: "what the customer asked for or was promised, in the rep's own words, lightly cleaned for filler only. Never re-worded into an email subject or a task title.",
            },
          },
          required: ["ask"],
        },
      },
      account_facts: {
        type: "object",
        description: "Facts about the BUSINESS itself, only when explicitly stated about the store/office as a whole, never inferred from a person's own contact info in people[]. Null fields are the common case, most visits state none of this.",
        properties: {
          business_hours: {
            type: ["object", "null"],
            description: "The business's stated hours, as a 7-key object (mon/tue/wed/thu/fri/sat/sun), each value an array of [\"HH:MM\",\"HH:MM\"] 24-hour windows (empty array for a closed day, e.g. a lunch break means two windows in one day). Only include a day the text actually covers; if the note states weekday hours but says nothing about the weekend, still return all 7 keys, empty array for the days not mentioned, rather than guessing they're closed. Null entirely if no hours were stated at all.",
          },
          phone: {
            type: ["string", "null"],
            description: "The business's own general/store phone number, only if stated as the store's number, not a specific person's direct line (that belongs in people[].phone).",
          },
          email: {
            type: ["string", "null"],
            description: "The business's own general/ordering email, only if stated as the store's address (e.g. 'their email is orders@...'), not a specific person's email (that belongs in people[].email).",
          },
        },
        required: ["business_hours", "phone", "email"],
      },
      next_step: {
        type: ["string", "null"],
        description: "The concrete next action for this account, in plain words, written so a different rep could act on it without rereading the note (e.g. \"Call back Thursday about the reorder\", \"Drop off a GSE sample on the next visit\", \"No follow-up, he is not interested\", \"Nothing further, he is all stocked up\"). Fill this whenever the text states or clearly implies what happens next, INCLUDING an explicit statement that nothing further is needed. IT MUST NAME WHAT HAPPENS. A bare \"follow up\", \"check in\", \"touch base\", \"keep in touch\", \"revisit\", or \"stay on it\" with no object is not a next action and must be left null, even though the rep said the words, because it tells the next reader nothing he could act on. Leave it null ONLY when the text says nothing at all about what comes next for this account, or says only something that vague, which is common and expected: never invent one to fill this field, and never sharpen a vague phrase into a specific-sounding action the rep did not state.",
      },
    },
    required: ["account_confidence", "business_name_guess", "activity", "people", "calendar_actions", "account_facts", "next_step", "directives", "outreach_asks"],
  },
};

function systemPrompt(nowIso: string, candidates: AccountCandidate[]): string {
  return `You extract structured field-sales data from one raw note a rep just typed about a store visit, call, or other touchpoint.

Reference time (America/Los_Angeles): ${nowIso}. Resolve every relative date/time ("Thursday", "next week", "in a month") against this reference.

Candidate accounts (id · name · city), pick the single best match or null:
${candidates.map((c) => `${c.id} · ${c.name} · ${c.city ?? "unknown city"}`).join("\n")}

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
- next_step is a short, concrete statement of what happens with this account next, written so a different rep could act on it without rereading the note. Fill it whenever the text states or clearly implies a next action, INCLUDING an explicit "no follow-up" ("he said no", "nothing further, not interested", "all set for now"). The bar is that it NAMES the action: "bring a GSE sample Thursday", "call Maria back about case pricing", "email the catalog to the buyer". A vague "follow up", "check in", "touch base" or "circle back" with no stated object is NOT a next action, and is left null so the rep gets asked directly rather than shipped a line nobody can act on. Leave it null when the text is silent, or only that vague; the rep is asked one short question and answers in his own words, which is always better than a guess. Never invent a next step, and never turn a vague phrase into a specific-sounding one.`;
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
  if (!client) return { ok: false, error: "ANTHROPIC_API_KEY is not configured on this deployment." };

  const now = new Date();
  let parsed: ParsedTouchpoint;
  try {
    const msg = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 1500,
      system: systemPrompt(now.toISOString(), candidates),
      messages: [{ role: "user", content: text }],
      tools: [EXTRACT_TOOL],
      tool_choice: { type: "tool", name: "extract_touchpoint" },
    });
    const toolUse = msg.content.find((b) => b.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use" || !isParsedTouchpoint(toolUse.input)) {
      return { ok: false, error: "Could not read that note. Try again." };
    }
    parsed = toolUse.input;
  } catch (err) {
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

async function finishTouchpoint(input: {
  accountId: string;
  accountName: string | null;
  parsed: ParsedTouchpoint;
  rawText: string;
  accountMatchConfidence: string | null;
}): Promise<FiledTouchpoint> {
  const { accountId, accountName, parsed } = input;

  // A retry of a note whose first try got as far as its touchpoint row: the
  // note is already in, so only the HubSpot filing (which dedupes its own
  // note) is run again. Never a second activity.
  const earlier = await findFiledTouchpoint(accountId, input.rawText).catch(() => null);
  if (earlier?.activity_id) {
    const hubspot = isNeverFiledKind(parsed.activity.kind)
      ? ({ hubspotFiled: false, hubspotNoteId: null, hubspotError: null } satisfies HubspotFilingReport)
      : await autoFileEngagement(earlier.activity_id);
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

  const hubspot = isNeverFiledKind(parsed.activity.kind)
    ? ({ hubspotFiled: false, hubspotNoteId: null, hubspotError: null } satisfies HubspotFilingReport)
    : await autoFileEngagement(activity.id);

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
