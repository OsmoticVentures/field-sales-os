"use client";

/**
 * A screen that crashed while rendering. The nav stays usable; the error is
 * reported once (lib/core/client-errors.ts) and Try again re-renders it.
 */
import { useEffect } from "react";
import { reportClientError } from "../../lib/core/client-errors";
import { primaryBtn } from "../../lib/core/ui";

export default function ScreenError({ error, unstable_retry }: { error: Error & { digest?: string }; unstable_retry: () => void }) {
  useEffect(() => {
    reportClientError(error, "boundary");
  }, [error]);

  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <h1 className="text-[20px] font-semibold tracking-tight">This screen hit a problem</h1>
      <button type="button" onClick={() => unstable_retry()} className={`${primaryBtn} mt-6 px-6`}>
        Try again
      </button>
    </div>
  );
}
