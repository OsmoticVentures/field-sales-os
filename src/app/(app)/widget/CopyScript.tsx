"use client";

import { useState } from "react";
import { ghostBtn, primaryBtn } from "../../../lib/core/ui";

/** Copies the bootstrap to the clipboard. The script is never rendered:
 *  it carries the widget token, so it only travels through the clipboard. */
export function CopyScript({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-wrap gap-2.5">
      <button
        type="button"
        className={primaryBtn}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1800);
          } catch {}
        }}
      >
        {copied ? "Copied" : "Copy script"}
      </button>
      <a href="scriptable:///add" className={ghostBtn}>
        New script in Scriptable
      </a>
    </div>
  );
}
