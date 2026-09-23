import { NextResponse } from "next/server";

// Route handler, not a server action. Every write in this app follows this
// pattern from the start (PORTING.md, m7): server actions can't ship
// cleanly in the static/native context the Capacitor shell needs (m12+).
export async function GET() {
  return NextResponse.json({ ok: true, service: "field-sales-os" });
}
