"use client";

/**
 * A draft's open-and-copy buttons, the one copy Outbound and Route both
 * draw: Open in Outlook addressed and prefilled (the Outlook app on the
 * phone, Outlook on the web elsewhere), Copy body beside it, and Copy body
 * alone when no email is on file. Nothing here sends; the compose window
 * is Juan's to send from.
 */

import { useState } from "react";
import { ghostBtn, primaryBtn } from "../../core/ui";
import type { Draft } from "./dal";
import { outlookAppComposeLink, owaComposeLink } from "./mail-links";
import { useOnPhone } from "./use-on-phone";
import { bodyToHtml, bodyToPlain, hasTable } from "./table-body";

/** Puts a draft body on the clipboard (rich when it holds a table). False
 *  when the browser refuses; the body is on screen either way. */
async function copyBody(body: string): Promise<boolean> {
  try {
    if (hasTable(body) && typeof ClipboardItem !== "undefined") {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([bodyToHtml(body)], { type: "text/html" }),
          "text/plain": new Blob([bodyToPlain(body)], { type: "text/plain" }),
        }),
      ]);
    } else {
      await navigator.clipboard.writeText(body);
    }
    return true;
  } catch {
    return false;
  }
}

export function CopyBodyButton({ body }: { body: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (await copyBody(body)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  return (
    <button type="button" onClick={copy} className={`${ghostBtn} bg-white px-3 text-[13px]`}>
      {copied ? "Copied" : "Copy body"}
    </button>
  );
}

type EmailDraft = Pick<Draft, "to_email" | "subject" | "body_md" | "bcc_email"> & { provider_msg_id?: string | null };

/** A draft already saved in his Outlook Drafts, with its table and any Cc
 *  (bridges/nutribiotic/order_watch.py, 2026-10-27), opens that draft: a
 *  compose link would open a second, bare copy. provider_msg_id carries its
 *  Outlook item id ("outlook-draft:<id>", 2026-10-29). The Outlook app has no
 *  link to a single message, so the phone opens it on the web too; a row saved
 *  before the id was kept opens the Drafts folder. */
const IN_OUTLOOK = "outlook-draft";
const OWA_DRAFTS = "https://outlook.cloud.microsoft/mail/drafts";
const OWA_DRAFT = "https://outlook.cloud.microsoft/mail/deeplink/compose/";

function outlookDraftHref(mark: string): string {
  const id = mark.slice(IN_OUTLOOK.length + 1);
  return id ? OWA_DRAFT + encodeURIComponent(id) : OWA_DRAFTS;
}

export function OpenEmailButtons({
  draft,
  label = <>Open in Outlook &rarr;</>,
  copy = true,
}: {
  draft: EmailDraft;
  label?: React.ReactNode;
  /** Copy body beside the open button; it stands alone when no email is on file. */
  copy?: boolean;
}) {
  const onPhone = useOnPhone();
  const [opened, setOpened] = useState(false);
  const tableBody = hasTable(draft.body_md);
  if (draft.provider_msg_id?.startsWith(IN_OUTLOOK)) {
    return (
      <a href={outlookDraftHref(draft.provider_msg_id)} target="_blank" rel="noopener noreferrer" className={`${primaryBtn} inline-flex items-center`}>
        {label}
      </a>
    );
  }
  const outlook = draft.to_email
    ? (onPhone ? outlookAppComposeLink : owaComposeLink)(draft.to_email, draft.subject, draft.body_md, draft.bcc_email, tableBody)
    : null;

  if (!draft.to_email || !outlook) {
    return (
      <>
        <CopyBodyButton body={draft.body_md} />
        <span className="text-[12px] text-[#8A928C]">No email on file, paste into their site&rsquo;s contact form.</span>
      </>
    );
  }
  return (
    <>
      {/* Outlook on the web drops a deep link's body when it bounces through
          sign-in or account select (Juan, 2026-11-03: "the open on outlook
          doesnt carry the body"), so opening also puts the body on the
          clipboard: an empty compose is one paste away, never a retype. */}
      <a href={outlook.href} target="_blank" rel="noopener noreferrer"
         onClick={() => { void copyBody(draft.body_md).then(setOpened); }}
         className={`${primaryBtn} inline-flex items-center`}>
        {label}
      </a>
      {copy && <CopyBodyButton body={draft.body_md} />}
      {opened && !onPhone && (
        <span className="text-[12px] text-[#8A928C]">Body copied. If Outlook opens empty, paste.</span>
      )}
      {outlook.bodyOmitted && !tableBody && (
        <span className="text-[12px] text-[#8A6D2F]">Too long to prefill. Outlook opens addressed, paste the body in.</span>
      )}
    </>
  );
}
