/**
 * The touchpoint extraction schema: what the model must return for one note.
 * The field descriptions are the extraction prompt (they were the forced
 * tool's input_schema) and are kept word for word; only the container
 * changed, to structured outputs, so every field is now required and a field
 * the note does not state comes back null.
 *
 * Pure (no "server-only"), so tests/ and the offline eval can import it.
 */
import { z } from "zod";

const hhmmWindows = z.array(z.array(z.string()));

/** A string the model leaves empty when the note states none, read back as
 *  null. Structured outputs allow 16 nullable (union) fields per request and
 *  this schema has 19 that matter, so the four lowest-stakes ones (a stated
 *  preference, a calendar note, a quote, a directive target) carry "none" as
 *  an empty string instead. Nothing downstream can tell the difference. */
const emptyIsNull = (description: string) =>
  z
    .string()
    .describe(`${description} Empty string when there is none.`)
    .transform((v) => (v.trim() && v.trim().toLowerCase() !== "null" ? v : null));

export const TouchpointSchema = z.object({
  account_id: z.string().nullable().describe("id of the best-matching account from the candidate list, or null if no confident match"),
  account_confidence: z.enum(["high", "low", "none"]),
  business_name_guess: z.string().nullable().describe("the business/store name AS STATED in the note, verbatim, even when account_confidence is low or none. Null only if no business name was said at all."),
  activity: z.object({
    kind: z
      .enum([
        "visit", "call", "text", "email_out", "email_in", "linkedin",
        "newsletter", "meeting", "note", "order", "sample_drop", "staff_training",
        "field_note",
      ])
      .describe("An in-person stop at a store or office, walked in or dropped by, is 'visit', even when the rep talks to or 'meets with' someone while there. Use 'meeting' only when the text itself frames it as a scheduled, formal meeting or appointment, not just a conversation that happened in person. This is what titles the HubSpot record ('Visit' vs 'Meeting'), and almost everything a rep dictates from the field is a visit. 'field_note' is the one kind that is NOT a customer contact: no store was called, walked into, emailed or texted. It covers an observation about a market or a storefront the rep only looked at, a note to self about how the work should go, and an instruction aimed at his own agency. A field note never reaches HubSpot, so choosing it wrongly hides real customer contact, and choosing anything else for a note to self invents a customer contact that never happened."),
    direction: z.enum(["outbound", "inbound", "internal"]),
    outcome: z
      .enum(["reached", "no_decision_maker", "closed", "declined", "reschedule", "no_answer", "left_sample"])
      .nullable()
      .describe("Use 'closed' only when the text says the BUSINESS ITSELF has shut down for good (out of business, permanently closed, the space is empty or another business is in it). Not for a deal being closed or won, and not for a store that merely happened to be closed at the time the rep stopped by, which is 'no_answer'."),
    detail: z.string().describe("what the rep said, kept in the rep's own first-person words ('I called...', not 'The rep called...'). Trim filler words and clean up punctuation/capitalization/structure, but never paraphrase into third person and never drop a stated fact. This is the full record kept in the OS, not what gets written to HubSpot."),
    hubspot_summary: z.string().describe("For the shared HubSpot record. Same first-person voice as detail ('I visited...', never 'Visited...' or 'The rep...') and the same no-fabrication rule. You may tighten repetition and filler words for readability, but never drop a fact the rep stated, including small color like where someone is from or what they said about themselves. This is not a shorter, lossier version of detail; it is the same account, in the rep's voice, cleaned up."),
  }),
  people: z.array(
    z.object({
      first_name: z.string().nullable(),
      last_name: z.string().nullable(),
      title: z.string().nullable(),
      role_tag: z.enum(["buyer", "owner", "manager", "clerk", "other"]).nullable().describe("What the text actually calls this person, not a default. 'owner' requires the text to say or clearly imply they own/run the store. 'buyer' means they were called the buyer or place/decide orders, never a fallback guess for an unspecified role. Null when no role is stated."),
      is_decision_maker: z.boolean(),
      email: z.string().nullable(),
      phone: z.string().nullable(),
      preferences: emptyIsNull("communication or relationship preference literally stated, e.g. 'prefers texts after 2pm'"),
    }),
  ),
  calendar_actions: z.array(
    z.object({
      kind: z.enum(["meeting", "reminder", "visit"]),
      title: z.string(),
      when_iso: z.string().nullable().describe("resolved absolute RFC3339 datetime with America/Los_Angeles offset, or null if no time was stated"),
      duration_minutes: z.number().int().nullable(),
      notes: emptyIsNull("Any detail about this calendar action worth keeping, as stated."),
      quote: emptyIsNull("The exact short clause or sentence, copied verbatim from the note, that states the return ask (e.g. \"come back next Friday\"). Not a paraphrase or a summary, the rep's own words only. Null if the note never states one as a distinct phrase."),
    }),
  ),
  directives: z
    .array(
      z.object({
        directive: z.string().describe("the instruction as the rep said it, verbatim, lightly cleaned for filler only. Never re-worded into a task title."),
        target: emptyIsNull("who should act, when the text makes it obvious: 'nutribiotic-enricher' (find a missing website/phone/decision maker), 'nutribiotic-route-planner' (go back, go see, plan a day), 'nutribiotic-account-analyst' (who is overdue, what do they buy, scoring), 'head-nutribiotic' (the sales OS itself), 'agent-maker' (build a new agent), 'head-pm' (plan a project). Null when it is not clear."),
        scope: z.enum(["nutribiotic", "agency"]).describe("'nutribiotic' when it is about this territory, its accounts, or this sales OS. 'agency' when it is about Juan's wider operation."),
      }),
    )
    .describe("Instructions the rep aimed at his own agency rather than content about a customer: 'go find their email from the website', 'build me an agent that...', 'draft an action plan and put it on my desktop'. An instruction inside a dictated note is not content for the note. Extract each one verbatim. Empty array is the normal answer; most notes carry none."),
  outreach_asks: z
    .array(
      z.object({
        ask: z.string().describe("what the customer asked for or was promised, in the rep's own words, lightly cleaned for filler only. Never re-worded into an email subject or a task title."),
      }),
    )
    .describe("Something the customer explicitly asked to be sent, or was promised, by email: pricing, a catalog, product/samples info, an order form, being added to a mailing list. Extract only when the text says the CUSTOMER asked for or was promised something to follow up on, in the rep's own words. IT MUST BE SOMETHING THE REP SENDS THEM. A thing the other side will send HIM is not an outreach ask however real it is. Empty array is the normal answer; most notes carry none."),
  account_facts: z
    .object({
      business_hours: z
        .object({ mon: hhmmWindows, tue: hhmmWindows, wed: hhmmWindows, thu: hhmmWindows, fri: hhmmWindows, sat: hhmmWindows, sun: hhmmWindows })
        .nullable()
        .describe("The business's stated hours, as a 7-key object (mon/tue/wed/thu/fri/sat/sun), each value an array of [\"HH:MM\",\"HH:MM\"] 24-hour windows (empty array for a closed day, e.g. a lunch break means two windows in one day). Only include a day the text actually covers; if the note states weekday hours but says nothing about the weekend, still return all 7 keys, empty array for the days not mentioned, rather than guessing they're closed. Null entirely if no hours were stated at all."),
      phone: z.string().nullable().describe("The business's own general/store phone number, only if stated as the store's number, not a specific person's direct line (that belongs in people[].phone)."),
      email: z.string().nullable().describe("The business's own general/ordering email, only if stated as the store's address (e.g. 'their email is orders@...'), not a specific person's email (that belongs in people[].email)."),
    })
    .describe("Facts about the BUSINESS itself, only when explicitly stated about the store/office as a whole, never inferred from a person's own contact info in people[]. Null fields are the common case, most visits state none of this."),
  next_step: z.string().nullable().describe("The concrete next action for this account, in plain words, written so a different rep could act on it without rereading the note (e.g. \"Call back Thursday about the reorder\", \"Drop off a GSE sample on the next visit\", \"No follow-up, he is not interested\", \"Nothing further, he is all stocked up\"). Fill this whenever the text states or clearly implies what happens next, INCLUDING an explicit statement that nothing further is needed. IT MUST NAME WHAT HAPPENS. A bare \"follow up\", \"check in\", \"touch base\", \"keep in touch\", \"revisit\", or \"stay on it\" with no object is not a next action and must be left null, even though the rep said the words, because it tells the next reader nothing he could act on. Leave it null ONLY when the text says nothing at all about what comes next for this account, or says only something that vague, which is common and expected: never invent one to fill this field, and never sharpen a vague phrase into a specific-sounding action the rep did not state."),
});

export type ExtractedTouchpoint = z.infer<typeof TouchpointSchema>;
