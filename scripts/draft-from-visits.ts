/**
 * Run the visit email trigger over touchpoints already filed, for a visit
 * logged before the trigger existed or one whose draft needs another try.
 * Same function the Visit screen's filing calls, same once-per-touchpoint
 * guard. Usage (needs NB_SUPABASE_* and ANTHROPIC_API_KEY in the env):
 *   npx tsx --conditions=react-server scripts/draft-from-visits.ts t_abc t_def
 */
import { draftFromVisit } from "../src/lib/features/outbound/from-visit";

const SB_URL = process.env.NB_SUPABASE_URL!;
const SB_KEY = process.env.NB_SUPABASE_SERVICE_ROLE_KEY!;

type Tp = { id: string; account_id: string | null; raw_text: string; parsed: Record<string, any> | null };

async function main() {
  const ids = process.argv.slice(2);
  if (!ids.length) throw new Error("Pass one or more touchpoint ids.");
  const res = await fetch(
    `${SB_URL}/rest/v1/nb_touchpoints?select=id,account_id,raw_text,parsed&id=in.(${ids.join(",")})`,
    { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } },
  );
  const rows = (await res.json()) as Tp[];
  for (const tp of rows) {
    if (!tp.account_id || !tp.parsed) {
      console.log(tp.id, "skipped: no account or parse");
      continue;
    }
    const out = await draftFromVisit({
      touchpointId: tp.id,
      accountId: tp.account_id,
      rawText: tp.raw_text,
      kind: tp.parsed.activity?.kind ?? "visit",
      nextStep: tp.parsed.next_step ?? null,
      outreachAsks: (tp.parsed.outreach_asks ?? []).map((a: { ask: string }) => a.ask).filter(Boolean),
    });
    console.log(tp.id, JSON.stringify(out));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
