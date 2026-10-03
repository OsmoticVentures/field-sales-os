"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Ico } from "../../../lib/core/ui";
import { TouchpointCapture } from "../../../lib/features/visit/ui";

/**
 * The capture box, with the client already chosen when Visit is opened from
 * a client's Log a visit (/visit?account=<id>&name=<name>). The note files
 * straight to that client, no store-guessing. Read on the phone so the page
 * itself stays static.
 */
export function VisitClient() {
  const params = useSearchParams();
  const router = useRouter();
  // Both or neither: a client he cannot see on screen is never filed to.
  const name = params.get("name")?.trim() || null;
  const accountId = name ? params.get("account") : null;

  return (
    <>
      {accountId && (
        <div className="mb-3 flex">
          <span className="inline-flex min-h-11 max-w-full items-center gap-2 rounded-full border border-[#14201B] bg-[#14201B] pr-1 pl-4 text-[13.5px] font-medium text-[#F7F6F1]">
            <span className="truncate">{name}</span>
            <button
              type="button"
              aria-label="Clear client"
              onClick={() => router.replace("/visit")}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-transform active:scale-[0.95]"
            >
              <Ico name="close" size={14} />
            </button>
          </span>
        </div>
      )}
      <TouchpointCapture
        key={accountId ?? "none"}
        accountIdHint={accountId}
        accountName={name}
        defaultKind={accountId ? "meeting" : undefined}
      />
    </>
  );
}
