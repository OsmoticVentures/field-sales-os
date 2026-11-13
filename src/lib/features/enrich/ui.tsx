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

  useEffect(() => {
    if (!note) return;
    const id = setTimeout(() => setNote(null), NOTE_MS);
    return () => clearTimeout(id);
  }, [note]);

  async function run() {
    if (running) return;
    setRunning(true);
    setNote(null);
    try {
      const res = await apiFetch("/api/enrich/run", {
        method: "POST",
        headers: { "content-type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ account_id: accountId }),
      });
      const j = await res.json().catch(() => null);
      const result = j?.ok ? (j.result as FindContactsResult) : null;
      // A pass that could not finish wrote nothing and says nothing.
      if (result?.status !== "ok") return;
      setNote(outcome(result));
      onUpdated?.();
    } catch {
      // No signal: quiet, the button is ready for another try.
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
    </div>
  );
}
