/**
 * Per-rep switches. Every change a rep asks for by text (Kyle, through the
 * iMessage bridge) lands behind one of these, on for that rep only. The
 * other rep's app stays exactly as it was until their id is added to `on`.
 *
 * One line per change: a kebab-case name, what it does in plain words, who
 * asked and when, and who has it. Turning a change on for Juan is adding
 * "juan" to its `on` list; dropping it is deleting the line and the code it
 * guards. Imported by server and client alike, so it holds plain data only.
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

/** Is this switch on for this rep? An unknown name is off for everyone. */
export function flagOn(userId: string | null | undefined, name: string): boolean {
  return Boolean(userId && REP_FLAGS[name]?.on.includes(userId));
}
