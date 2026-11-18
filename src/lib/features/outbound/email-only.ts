/**
 * Route's "Email only" on a stop: find the angle, write the email, file it
 * on Outbound and nowhere else (Juan, 2026-11-17: "draft an email in
 * outbound but not in Outlook drafts").
 *
 * THE ANGLE, his rule:
 *   1. No meeting or call with notes in the last RECENT_TOUCH_DAYS (the SDR
 *      score's own line for a recent touch): the account needs reviving.
 *      Send them the portfolio and say I am here to help them decide what
 *      is best for their clients.
 *   2. Otherwise: read those meetings and calls, and the email follows up
 *      on what was set in them.
 *
 * Same composer and the same grounding gate as every other draft
 * (compose.ts): the email may only reword the angle and the notes given.
 * Filed under EMAIL_ONLY_PLAY, which bridges/nutribiotic/order_watch.py
 * holds out of Outlook Drafts. Nothing here sends.
 */
import "server-only";
import { CONVERSATION_KINDS, RECENT_TOUCH_DAYS, laDay } from "../prospect/sdr-score";
import { loadAskInputs } from "./actions";
import { asksCollide, composeAsk } from "./compose";
import { insertAskDraft, listRecentConversations, type Conversation } from "./dal";

/** The play an Email only draft is filed under. Mirrored in order_watch.py HELD_PLAYS. */
export const EMAIL_ONLY_PLAY = "email_only";

export type Angle = "revival" | "recent";

export type EmailOnlyResult =
  | { status: "drafted"; angle: Angle }
  | { status: "already_queued"; angle: Angle }
  | { status: "not_written"; angle: Angle | null; reason: string };

const REVIVAL_ASK = "Send them the NutriBiotic Portfolio and say I am here for them, to help them decide what is best for their clients.";
const RECENT_ASK = "Follow up on what was set in our recent meetings and calls, and move it to the next step they name.";

const KIND_LABEL: Record<string, string> = {
  visit: "Visit",
  meeting: "Meeting",
  sample_drop: "Sample drop",
  staff_training: "Staff training",
  call: "Call",
};

const SHORT_DAY = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric" });

function conversationLine(c: Conversation): string {
  return `${KIND_LABEL[c.kind] ?? c.kind}, ${SHORT_DAY.format(new Date(c.at))}: ${(c.detail ?? "").trim()}`;
}

/** The angle for one account, and the note the email is written from. */
export async function findAngle(accountId: string, today = new Date()): Promise<{ angle: Angle; ask: string; noteText: string }> {
  const since = new Date(today.getTime() - RECENT_TOUCH_DAYS * 86_400_000);
  const talks = (await listRecentConversations(accountId, `${laDay(since)}T00:00:00`, CONVERSATION_KINDS)).filter(
    (c) => (c.detail ?? "").trim().length > 0,
  );
  if (talks.length === 0) {
    return {
      angle: "revival",
      ask: REVIVAL_ASK,
      noteText: `No meeting or call with them in the last ${RECENT_TOUCH_DAYS} days.\n\n${REVIVAL_ASK}`,
    };
  }
  return {
    angle: "recent",
    ask: RECENT_ASK,
    noteText: `Our meetings and calls, newest first:\n\n${talks.map(conversationLine).join("\n\n")}`,
  };
}

export async function draftEmailOnly(accountId: string): Promise<EmailOnlyResult> {
  const { account, contacts, alreadyFiled, voice } = await loadAskInputs(accountId);
  if (!account) return { status: "not_written", angle: null, reason: "Account not found in your book." };

  const { angle, ask, noteText } = await findAngle(accountId);
  // One waiting at a time: a second tap while this angle's email is still on Outbound files nothing.
  if (alreadyFiled.some((r) => r.status === "pending" && asksCollide(r.source_ask, ask))) {
    return { status: "already_queued", angle };
  }

  const composed = await composeAsk({
    ask,
    noteText,
    account: { id: account.id, name: account.name, city: account.city, email: account.email },
    contacts,
    voice,
  });
  if (!composed.written) return { status: "not_written", angle, reason: composed.reason };
  await insertAskDraft({ account_id: accountId, ask, composed, play_key: EMAIL_ONLY_PLAY });
  return { status: "drafted", angle };
}
