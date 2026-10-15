/**
 * Outlook Web compose link, prefilled. Ported from the NutriBiotic OS's
 * lib/outbound-ui.tsx (owaComposeLink). Opens in the same tab, addressed and
 * ready; nothing sends until Juan taps Send inside his own mailbox. This
 * mailbox holds no Mail.Send scope, so a compose deep link is the only path
 * that exists, and it needs no API credential: it is just a URL.
 */

/**
 * How long the whole compose URL may get before the body is left out.
 *
 * A deep link is a query string, and percent-encoding roughly doubles a
 * markdown body once newlines and punctuation are escaped. Browsers and the
 * Outlook endpoint both stop carrying one somewhere in the low thousands of
 * characters, and the failure is quiet: the link still opens, just without
 * the text. 1900 is comfortably under the most conservative of those
 * ceilings.
 */
export const COMPOSE_URL_LIMIT = 1900;

function owaQuery(params: Record<string, string>): string {
  // Not URLSearchParams: its toString() encodes spaces as "+" (form
  // encoding), and the Outlook deep-link endpoint shows that "+" literally
  // instead of decoding it back to a space. encodeURIComponent emits %20.
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

export function owaComposeLink(
  toEmail: string,
  subject: string | null,
  body: string,
  bccEmail?: string | null,
  /** A table body: a compose link carries plain text only, so it opens addressed and the body is pasted. */
  omitBody = false,
): { href: string; bodyOmitted: boolean } {
  const base = "https://outlook.cloud.microsoft/mail/deeplink/compose?";
  const withBodyParams: Record<string, string> = { to: toEmail, body };
  if (subject) withBodyParams.subject = subject;
  if (bccEmail) withBodyParams.bcc = bccEmail;
  const full = base + owaQuery(withBodyParams);
  if (!omitBody && full.length <= COMPOSE_URL_LIMIT) return { href: full, bodyOmitted: false };

  const withoutBodyParams: Record<string, string> = { to: toEmail };
  if (subject) withoutBodyParams.subject = subject;
  if (bccEmail) withoutBodyParams.bcc = bccEmail;
  return { href: base + owaQuery(withoutBodyParams), bodyOmitted: true };
}

/**
 * The Outlook app's own compose link (ms-outlook://), for the phone. The app
 * shell hands any non-web link to iOS, which opens Outlook addressed and
 * filled. App-to-app links carry no practical length ceiling, so the body
 * rides along unless it holds a table, which a compose link cannot draw.
 */
export function outlookAppComposeLink(
  toEmail: string,
  subject: string | null,
  body: string,
  bccEmail?: string | null,
  omitBody = false,
): { href: string; bodyOmitted: boolean } {
  const params: Record<string, string> = { to: toEmail };
  if (subject) params.subject = subject;
  if (bccEmail) params.bcc = bccEmail;
  if (!omitBody) params.body = body;
  return { href: "ms-outlook://compose?" + owaQuery(params), bodyOmitted: omitBody };
}
