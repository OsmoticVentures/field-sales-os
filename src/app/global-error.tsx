"use client";

/**
 * The last boundary: the root layout itself failed. Replaces the whole page,
 * so it carries its own html/body and plain inline styles (globals.css may be
 * what broke).
 */
import { useEffect } from "react";
import { reportClientError } from "../lib/core/client-errors";

export default function GlobalError({ error, unstable_retry }: { error: Error & { digest?: string }; unstable_retry: () => void }) {
  useEffect(() => {
    reportClientError(error, "global-boundary");
  }, [error]);

  return (
    <html lang="en">
      <body style={{ margin: 0, background: "#F7F6F1", color: "#14201B", fontFamily: "system-ui, -apple-system, sans-serif" }}>
        <div style={{ maxWidth: 420, margin: "0 auto", padding: "96px 20px", textAlign: "center" }}>
          <h1 style={{ fontSize: 20, fontWeight: 600 }}>ClientOS hit a problem</h1>
          <button
            type="button"
            onClick={() => unstable_retry()}
            style={{ marginTop: 24, minHeight: 44, padding: "0 24px", borderRadius: 12, border: 0, background: "#14201B", color: "#FAF9F5", fontSize: 14, fontWeight: 500 }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
