/**
 * Per-rep switches. Every change a rep asks for by text (Kyle, through the
 * iMessage bridge) lands behind one of these, on for that rep only. The
 * other rep's app stays exactly as it was until their id is added to `on`.
 *
 * One line per change: a kebab-case name, what it does in plain words, who
 * asked and when, and who has it. Dropping a change is deleting the line and
 * the code it guards. Imported by server and client alike, so it holds plain
 * data only.
 *
 * THIS FILE IS THE DEFAULT, nb_flags IS THE SWITCH (supabase/0003). A row in
 * nb_flags (flag, rep, value) overrides the `on` list below for that rep, or
 * for every rep with rep "*"; a rep's own row beats "*". No row, or no table,
 * and the app behaves exactly as this file says. Flip one without a deploy:
 *
 *   node scripts/flag.mjs set no-area-filters juan on
 *   node scripts/flag.mjs clear no-area-filters juan      (back to this file)
 *
 * A risky change lands dark: add its line here with `on: []`, guard the code
 * with useFlag(name) on the client or myFlag(name) on the server, then turn
 * it on for one rep with a row. Server reads go through flags.ts, cached a
 * minute per instance; the client gets its list from /api/me.
 */

export type RepFlag = {
  /** What the rep sees differently, in plain words. */
  about: string;
  /** Who asked, and the date: "kyle 2026-10-07". */
  asked: string;
  /** nb_users ids this is on for. */
  on: string[];
};

export const REP_FLAGS: Record<string, RepFlag> = {
  "no-area-filters": {
    about: "No area filters on the route map or the Clients screen",
    asked: "juan for kyle 2026-10-07",
    on: ["kyle"],
  },
};

/** Is this switch on for this rep, by this file alone? An unknown name is
 *  off for everyone. */
export function flagOn(userId: string | null | undefined, name: string): boolean {
  return Boolean(userId && REP_FLAGS[name]?.on.includes(userId));
}

/** One nb_flags row. */
export type FlagRow = { flag: string; rep: string; value: boolean };

/** Every switch on for this rep: this file's defaults, then "*" rows, then
 *  the rep's own rows. Sorted, so two answers compare by value. */
export function resolveFlags(userId: string | null | undefined, rows: readonly FlagRow[]): string[] {
  if (!userId) return [];
  const on = new Set(Object.keys(REP_FLAGS).filter((name) => REP_FLAGS[name].on.includes(userId)));
  for (const scope of ["*", userId]) {
    for (const r of rows) {
      if (r.rep !== scope || typeof r.flag !== "string") continue;
      if (r.value === true) on.add(r.flag);
      else if (r.value === false) on.delete(r.flag);
    }
  }
  return [...on].sort();
}
