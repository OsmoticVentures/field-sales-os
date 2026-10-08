import { NextResponse } from "next/server";
import { stage } from "../../../lib/core/stage";

// Route handler, not a server action. Every write in this app follows this
// pattern from the start (PORTING.md, m7): server actions can't run
// cleanly in the static/native context the Capacitor shell needs (m12+).
// `stage` says which deployment answered (lib/core/stage.ts), so a check
// against the staging alias can tell it is not production.
export async function GET() {
  return NextResponse.json({ ok: true, service: "field-sales-os", stage: stage() });
}
