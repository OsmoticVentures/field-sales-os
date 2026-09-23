/**
 * Carrying one logged activity across the HubSpot boundary as a Note, Call,
 * or Meeting. Ported from portfolio/src/app/nutribiotic/lib/hubspot-engagement.ts,
 * which is itself a port of bridges/nutribiotic/hubspot_notes.py. The body
 * builder below (typedProperties, noteLines, noteBody, the marker) is kept
 * exactly, per this milestone's instruction.
 *
 * NOT PORTED, deliberately (see the handback for the full list): creating a
 * new HubSpot contact for an unmatched person, pushing the company phone
 * back to HubSpot, and the association-leak auto-detach. Those are all
 * enrichment on top of a filed engagement, not the engagement itself, and
 * every one of them only runs when NB_HUBSPOT_WRITE_ENABLED is "true",
 * which this deployment leaves off. An account with no portal company yet
 * (hubspot-graduate.ts's job in the source) is refused here rather than
 * auto-created; the touchpoint still files into the OS either way.
 */
import "server-only";
import {
  findRecentDuplicateEngagement,
  getAccountForEngagement,
  getActivityById,
  listContacts,
  stampActivityEngagementId,
  type Contact,
  type EngagementActivity,
} from "./dal";
import { assertJuansBook, OWNER_ID, request } from "./hubspot";

export class Blocked extends Error {}

const NOTE_TO_COMPANY = 190;
const NOTE_TO_CONTACT = 202;
const CALL_TO_COMPANY = 182;
const CALL_TO_CONTACT = 194;
const MEETING_TO_COMPANY = 188;
const MEETING_TO_CONTACT = 200;
const EMAIL_TO_COMPANY = 186;
const EMAIL_TO_CONTACT = 198;

type EngagementType = "NOTE" | "CALL" | "MEETING" | "EMAIL" | "INCOMING_EMAIL";

const ENGAGEMENT_OBJECT: Record<EngagementType, string> = {
  NOTE: "notes",
  CALL: "calls",
  MEETING: "meetings",
  EMAIL: "emails",
  INCOMING_EMAIL: "emails",
};
const ENGAGEMENT_TO_COMPANY: Record<EngagementType, number> = {
  NOTE: NOTE_TO_COMPANY,
  CALL: CALL_TO_COMPANY,
  MEETING: MEETING_TO_COMPANY,
  EMAIL: EMAIL_TO_COMPANY,
  INCOMING_EMAIL: EMAIL_TO_COMPANY,
};
const ENGAGEMENT_TO_CONTACT: Record<EngagementType, number> = {
  NOTE: NOTE_TO_CONTACT,
  CALL: CALL_TO_CONTACT,
  MEETING: MEETING_TO_CONTACT,
  EMAIL: EMAIL_TO_CONTACT,
  INCOMING_EMAIL: EMAIL_TO_CONTACT,
};

const CALL_DISPOSITION_CONNECTED = "f240bbac-87c9-4f6e-bf70-924b57d47db7";
const CALL_DISPOSITION_NO_ANSWER = "73a0d17f-1163-4015-bdd5-ec830791da20";
const CALL_DISPOSITION: Record<string, string> = {
  reached: CALL_DISPOSITION_CONNECTED,
  no_decision_maker: CALL_DISPOSITION_CONNECTED,
  closed: CALL_DISPOSITION_CONNECTED,
  declined: CALL_DISPOSITION_CONNECTED,
  reschedule: CALL_DISPOSITION_CONNECTED,
  left_sample: CALL_DISPOSITION_CONNECTED,
  no_answer: CALL_DISPOSITION_NO_ANSWER,
};

const MEETING_OUTCOME: Record<string, string> = { reschedule: "RESCHEDULED", declined: "NO_SHOW" };
const DEFAULT_MEETING_OUTCOME = "COMPLETED";

const OUTCOME_LABEL: Record<string, string> = {
  reached: "reached the person we came for",
  no_decision_maker: "decision maker not available",
  closed: "closed",
  declined: "declined",
  reschedule: "to be rescheduled",
  no_answer: "no answer",
  left_sample: "sample left",
};

const KIND_LABEL: Record<string, string> = {
  visit: "Visit",
  call: "Call",
  text: "Text",
  email_out: "Email sent",
  email_in: "Email received",
  linkedin: "LinkedIn",
  newsletter: "Newsletter",
  meeting: "Meeting",
  note: "Note",
  order: "Order",
  sample_drop: "Sample drop",
  staff_training: "Staff training",
  field_note: "Field note",
};

/** Kinds that must never reach the shared portal. Mirrors
 *  nutribiotic/config/hubspot_fields.json's activity_kind_map: "field_note"
 *  is listed as null there and refused here before the map is even read. */
const NEVER_FILED = new Set(["field_note"]);

export function isNeverFiledKind(kind: string): boolean {
  return NEVER_FILED.has(kind);
}

/** activity.kind -> HubSpot engagement type. Ported verbatim from
 *  nutribiotic/config/hubspot_fields.json's engagements.activity_kind_map,
 *  which the source reads dynamically via readConfig(); mirrored as a
 *  constant here since this port has no config-mirroring layer. */
const ACTIVITY_KIND_MAP: Record<string, EngagementType | null> = {
  field_note: null,
  visit: "MEETING",
  meeting: "MEETING",
  call: "CALL",
  text: "NOTE",
  email_out: "EMAIL",
  email_in: "INCOMING_EMAIL",
  linkedin: "NOTE",
  newsletter: "EMAIL",
  note: "NOTE",
  sample_drop: "NOTE",
  staff_training: "MEETING",
  order: "NOTE",
};

export class NeverFiledKindError extends Error {
  constructor(kind: string) {
    super(`${kind} is never filed to HubSpot. It lives in the OS only.`);
    this.name = "NeverFiledKindError";
  }
}

function engagementType(kind: string): EngagementType {
  if (NEVER_FILED.has(kind)) throw new NeverFiledKindError(kind);
  return ACTIVITY_KIND_MAP[kind] ?? "NOTE";
}

function effectiveType(etype: EngagementType): EngagementType {
  return etype in ENGAGEMENT_OBJECT ? etype : "NOTE";
}

function hsTimestamp(activity: EngagementActivity): number {
  const raw = activity.at || activity.logged_at;
  if (!raw) return Date.now();
  return new Date(raw).getTime();
}

/** The dedup marker: an HTML comment, invisible in HubSpot's render, found
 *  by alreadyFiled()'s CONTAINS_TOKEN search. This is the idempotency
 *  layer that catches a POST-succeeded-stamp-failed race. */
const marker = (activityId: number): string => `[nb-activity:${activityId}]`;

function typedProperties(
  otype: EngagementType,
  activity: EngagementActivity,
  body: string,
  plainBody: string,
): Record<string, string | number | null> {
  const ts = hsTimestamp(activity);
  const kind = activity.kind || "";
  const outcome = (activity.outcome || "").trim();
  const title = KIND_LABEL[kind] ?? kind;

  if (otype === "EMAIL" || otype === "INCOMING_EMAIL") {
    return {
      hs_timestamp: ts,
      hs_email_subject: title,
      hs_email_html: body,
      hs_email_text: plainBody,
      hs_email_direction: otype === "INCOMING_EMAIL" ? "INCOMING_EMAIL" : "EMAIL",
      hs_email_status: "SENT",
      hubspot_owner_id: OWNER_ID,
    };
  }
  if (otype === "CALL") {
    return {
      hs_timestamp: ts,
      hs_call_title: title,
      hs_call_body: body,
      hs_call_direction: activity.direction === "inbound" ? "INBOUND" : "OUTBOUND",
      hs_call_status: "COMPLETED",
      hs_call_disposition: CALL_DISPOSITION[outcome] ?? null,
      hubspot_owner_id: OWNER_ID,
    };
  }
  if (otype === "MEETING") {
    const end = ts + 30 * 60 * 1000;
    return {
      hs_timestamp: ts,
      hs_meeting_title: title,
      hs_meeting_body: body,
      hs_meeting_start_time: ts,
      hs_meeting_end_time: end,
      hs_meeting_outcome: MEETING_OUTCOME[outcome] ?? DEFAULT_MEETING_OUTCOME,
      hubspot_owner_id: OWNER_ID,
    };
  }
  return { hs_timestamp: ts, hs_note_body: body, hubspot_owner_id: OWNER_ID };
}

type MatchedPerson = { contact: Contact; person: ParsedPerson | null };
type ParsedPerson = {
  first_name?: string | null;
  last_name?: string | null;
  title?: string | null;
  email?: string | null;
  phone?: string | null;
};

/** Matching only, against contacts already in nb_contacts. A person named
 *  in the note who is not already on file is a finding surfaced by the
 *  touchpoint filing itself, not created here (see the file header). */
function matchPeople(
  contacts: Contact[],
  activity: EngagementActivity,
  parsed: { people?: ParsedPerson[] } | null,
): { matched: MatchedPerson[]; unmatched: ParsedPerson[] } {
  const key = (first?: string | null, last?: string | null) =>
    `${(first ?? "").trim().toLowerCase()} ${(last ?? "").trim().toLowerCase()}`.trim();
  const byName = new Map(contacts.map((c) => [key(c.first_name, c.last_name), c]));
  const byEmail = new Map(contacts.filter((c) => c.email).map((c) => [(c.email as string).trim().toLowerCase(), c]));

  const matched: MatchedPerson[] = [];
  const unmatched: ParsedPerson[] = [];

  if (activity.contact_id) {
    const hit = contacts.find((c) => c.id === activity.contact_id);
    if (hit) matched.push({ contact: hit, person: null });
  }

  for (const p of parsed?.people ?? []) {
    const em = (p.email ?? "").trim().toLowerCase();
    let hit = em ? byEmail.get(em) : undefined;
    if (!hit) {
      const k = key(p.first_name, p.last_name);
      if (k) hit = byName.get(k);
    }
    if (!hit) {
      unmatched.push(p);
      continue;
    }
    const already = matched.find((m) => m.contact.id === hit!.id);
    if (already) already.person = already.person ?? p;
    else matched.push({ contact: hit, person: p });
  }
  return { matched, unmatched };
}

function noteLines(
  activity: EngagementActivity,
  matched: MatchedPerson[],
  etype: EngagementType,
  otype: EngagementType,
  hubspotSummary: string | null,
  nextStep: string | null,
): string[] {
  const kind = activity.kind || "note";
  const when = (activity.at || "").slice(0, 16).replace("T", " ");
  let head = when ? `${KIND_LABEL[kind] ?? kind} · ${when}` : (KIND_LABEL[kind] ?? kind);
  if (otype !== etype) head += ` · would be logged as ${etype}, filed as NOTE (not built yet)`;

  const lines = [head];

  const outcome = (activity.outcome || "").trim();
  if (outcome) lines.push(`Outcome: ${OUTCOME_LABEL[outcome] ?? outcome}`);

  const body = (hubspotSummary || "").trim() || (activity.detail || "").trim();
  if (body) {
    lines.push("");
    lines.push(body);
  }

  const names = matched
    .map((m) => {
      const n = [m.contact.first_name, m.contact.last_name].filter(Boolean).join(" ").trim();
      if (!n) return null;
      return m.contact.title ? `${n} (${m.contact.title})` : n;
    })
    .filter((n): n is string => Boolean(n));
  if (names.length > 0) {
    lines.push("");
    lines.push(`Spoke with: ${names.join(", ")}`);
  }

  const step = (nextStep || "").trim();
  if (step) {
    lines.push("");
    lines.push(`Next step: ${step}`);
  }

  return lines;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function noteBody(lines: string[], activityId: number): string {
  return lines.map(escapeHtml).join("<br>") + `<!--${marker(activityId)}-->`;
}

/** Best-effort search for an engagement already carrying this activity's
 *  marker: catches the POST-succeeded-stamp-failed window. */
async function alreadyFiled(activityId: number, otype: EngagementType): Promise<string | null> {
  const objectType = ENGAGEMENT_OBJECT[otype];
  const bodyProp =
    otype === "CALL" ? "hs_call_body" : otype === "MEETING" ? "hs_meeting_body" : otype === "EMAIL" || otype === "INCOMING_EMAIL" ? "hs_email_html" : "hs_note_body";
  try {
    const res = await request<{ results?: Array<{ id: string; properties?: Record<string, string | null> }> }>({
      method: "POST",
      path: `/crm/v3/objects/${objectType}/search`,
      body: {
        limit: 5,
        properties: [bodyProp],
        filterGroups: [{ filters: [{ propertyName: bodyProp, operator: "CONTAINS_TOKEN", value: `*nb-activity:${activityId}*` }] }],
      },
      entity: objectType,
      operation: "search",
    });
    for (const r of res.results ?? []) {
      if ((r.properties?.[bodyProp] ?? "").includes(marker(activityId))) return r.id;
    }
  } catch {
    return null;
  }
  return null;
}

export type EngagementResult = {
  status: "ok";
  activityId: number;
  accountId: string;
  accountName: string;
  otype: EngagementType;
  etype: EngagementType;
  lines: string[];
  matchedNames: string[];
  alreadyFiledId: string | null;
  wrote: boolean;
  noteId: string | null;
};

/** One activity, all the way to a Note/Call/Meeting, or a dry preview of
 *  the same. Mirrors the source's runEngagement: every read runs
 *  regardless of `write`; only the final POST and its stamp are gated. */
export async function runEngagement(activityId: number, opts: { write: boolean }): Promise<EngagementResult> {
  const activity = await getActivityById(activityId);
  if (!activity) throw new Blocked(`nb_activities has no row with id ${activityId}.`);
  if (!activity.account_id) throw new Blocked(`activity ${activityId} has no account_id.`);

  const account = await getAccountForEngagement(activity.account_id);
  if (!account) throw new Blocked(`nb_accounts has no row with id ${activity.account_id}.`);
  if ((account.owner_name ?? "") !== "Juan Arenas Martin") {
    throw new Blocked(`account ${account.id} (${account.name}) is owned by '${account.owner_name || "(unowned)"}', not Juan Arenas Martin. Out of scope.`);
  }
  if (!account.hubspot_company_id) {
    throw new Blocked(`account ${account.id} (${account.name}) is not linked to a portal company. Linking is a human decision.`);
  }
  const companyId = account.hubspot_company_id;
  const etype = engagementType(activity.kind || "note");
  const otype = effectiveType(etype);

  if (activity.hubspot_engagement_id) {
    return {
      status: "ok", activityId, accountId: account.id, accountName: account.name, otype, etype,
      lines: [], matchedNames: [], alreadyFiledId: activity.hubspot_engagement_id, wrote: false, noteId: activity.hubspot_engagement_id,
    };
  }

  if (activity.detail) {
    const sibling = await findRecentDuplicateEngagement(account.id, activity.detail, activityId);
    if (sibling) {
      if (opts.write) await stampActivityEngagementId(activityId, sibling.hubspot_engagement_id);
      return {
        status: "ok", activityId, accountId: account.id, accountName: account.name, otype, etype,
        lines: [], matchedNames: [], alreadyFiledId: sibling.hubspot_engagement_id, wrote: false, noteId: sibling.hubspot_engagement_id,
      };
    }
  }

  const contacts = await listContacts(account.id);
  const parsed = { people: [] as ParsedPerson[] };
  const { matched } = matchPeople(contacts, activity, parsed);
  const contactIds = matched.map((m) => m.contact.hubspot_contact_id).filter((v): v is string => Boolean(v));

  const lines = noteLines(activity, matched, etype, otype, activity.detail, null);
  const body = noteBody(lines, activityId);
  const matchedNames = matched
    .map((m) => [m.contact.first_name, m.contact.last_name].filter(Boolean).join(" ").trim())
    .filter(Boolean);

  if (!opts.write) {
    return { status: "ok", activityId, accountId: account.id, accountName: account.name, otype, etype, lines, matchedNames, alreadyFiledId: null, wrote: false, noteId: null };
  }

  const scope = await assertJuansBook([companyId]);
  if (!scope.allowed.includes(companyId)) {
    const dropped = scope.dropped.find((d) => d.id === companyId);
    throw new Blocked(`portal company ${companyId} (${account.name}) has hubspot_owner_id ${dropped?.owner ?? "(none)"}, not Juan's ${OWNER_ID}. DROPPED, nothing written.`);
  }

  const dup = await alreadyFiled(activityId, otype);
  let noteId: string;
  if (dup) {
    noteId = dup;
  } else {
    const assoc = [
      { to: { id: companyId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: ENGAGEMENT_TO_COMPANY[otype] }] },
      ...contactIds.map((cid) => ({ to: { id: cid }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: ENGAGEMENT_TO_CONTACT[otype] }] })),
    ];
    const props = typedProperties(otype, activity, body, lines.join("\n"));
    const writeProps = Object.fromEntries(Object.entries(props).filter(([, v]) => v !== null));
    const res = await request<{ id?: string }>({
      method: "POST",
      path: `/crm/v3/objects/${ENGAGEMENT_OBJECT[otype]}`,
      body: { properties: writeProps, associations: assoc },
      entity: ENGAGEMENT_OBJECT[otype],
      operation: "create",
    });
    if (!res.id) throw new Blocked(`HubSpot accepted the ${otype.toLowerCase()} but returned no id; refusing to stamp.`);
    noteId = res.id;
  }

  await stampActivityEngagementId(activityId, noteId);
  return { status: "ok", activityId, accountId: account.id, accountName: account.name, otype, etype, lines, matchedNames, alreadyFiledId: null, wrote: !dup, noteId };
}
