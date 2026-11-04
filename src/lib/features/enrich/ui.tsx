/**
 * Find Contacts: one button on the call card. The pass saves what it finds and
 * the card's own Contacts list shows the result, name, title, phone and email.
 * This component only says the pass finished, or why it could not.
 */
"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "../../core/api";
import { Ico, SuccessNote, ghostBtn } from "../../core/ui";
import type { FindContactsResult } from "./types";

/** A beat to read it, then the note leaves and the Contacts list remains. */
const NOTE_MS = 1100;

function outcome(r: FindContactsResult): string {
  if (r.contacts_added > 0) return r.contacts_added === 1 ? "1 contact added" : `${r.contacts_added} contacts added`;
  return r.contacts_updated > 0 ? "Contacts updated" : "No new contacts";
}

export function FindContacts({ accountId, onUpdated }: { accountId: string; onUpdated?: () => void }) {
  const [running, setRunning] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!note) return;
    const id = setTimeout(() => setNote(null), NOTE_MS);
    return () => clearTimeout(id);
  }, [note]);

  async function run() {
    if (running) return;
    setRunning(true);
    setError(null);
    setNote(null);
    try {
      const res = await apiFetch("/api/enrich/run", {
        method: "POST",
        headers: { "content-type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ account_id: accountId }),
      });
      const j = await res.json().catch(() => null);
      if (!j) throw new Error(res.status === 504 ? "That took too long. Try again." : "Could not finish. Try again.");
      if (!j.ok) throw new Error(j.error || "Could not finish. Try again.");
      const result = j.result as FindContactsResult;
      if (result.status !== "ok") throw new Error(result.error || "Could not finish. Try again.");
      setNote(outcome(result));
      onUpdated?.();
    } catch (e) {
      // A dropped connection surfaces as a TypeError from fetch; say so plainly.
      setError(e instanceof TypeError ? "No connection. Try again when you have signal." : e instanceof Error ? e.message : "Could not finish. Try again.");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <button type="button" onClick={run} disabled={running} className={`${ghostBtn} whitespace-nowrap`}>
        <Ico name="search" size={13} />
        {running ? "Finding contacts" : "Find contacts"}
      </button>
      {note && !running && <SuccessNote title={note} />}
      {error && !running && (
        <span className="inline-flex items-center gap-1.5 text-[13.5px] text-[#8A6D2F]">
          <Ico name="alert" size={13} />
          {error}
        </span>
      )}
    </div>
  );
}
