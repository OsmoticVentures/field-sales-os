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

export function CopyBodyButton({ body }: { body: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
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
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard permission refused. The body is on screen above either
      // way, so this degrades to selecting it by hand rather than to
      // nothing.
    }
  }

  return (
    <button type="button" onClick={copy} className={`${ghostBtn} bg-white px-3 text-[13px]`}>
      {copied ? "Copied" : "Copy body"}
    </button>
  );
}

type EmailDraft = Pick<Draft, "to_email" | "subject" | "body_md" | "bcc_email">;

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
  const tableBody = hasTable(draft.body_md);
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
      <a href={outlook.href} target="_blank" rel="noopener noreferrer" className={`${primaryBtn} inline-flex items-center`}>
        {label}
      </a>
      {copy && <CopyBodyButton body={draft.body_md} />}
      {outlook.bodyOmitted && !tableBody && (
        <span className="text-[12px] text-[#8A6D2F]">Too long to prefill. Outlook opens addressed, paste the body in.</span>
      )}
    </>
  );
}
