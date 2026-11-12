/**
 * The due clock on a promised email. Juan, 2026-11-12: every email he owes
 * is due within 2 business days of the visit or note that created it.
 * Pure (no imports), so tests and bridges/nutribiotic/outbound_due.py agree.
 */

export const DUE_BUSINESS_DAYS = 2;
const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** YYYY-MM-DD of an instant in Los Angeles. */
export function laIso(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const isWeekend = (iso: string) => [0, 6].includes(new Date(`${iso}T12:00:00Z`).getUTCDay());

/** The business day a draft created at `createdAt` is due. */
export function dueDay(createdAt: string): string {
  let day = laIso(new Date(createdAt));
  for (let left = DUE_BUSINESS_DAYS; left > 0; ) {
    day = addDays(day, 1);
    if (!isWeekend(day)) left--;
  }
  return day;
}

/** Business days past due on `today` (0 when not late). */
export function businessDaysLate(due: string, today: string): number {
  let n = 0;
  for (let day = due; day < today; ) {
    day = addDays(day, 1);
    if (!isWeekend(day)) n++;
  }
  return n;
}

/** The chip on the card: "due today", "due Fri", "3 days late". */
export function dueLabel(createdAt: string, today: string): { text: string; late: boolean } {
  const due = dueDay(createdAt);
  const late = businessDaysLate(due, today);
  if (late > 0) return { text: late === 1 ? "1 day late" : `${late} days late`, late: true };
  if (due === today) return { text: "due today", late: false };
  return { text: `due ${WEEKDAY[new Date(`${due}T12:00:00Z`).getUTCDay()]}`, late: false };
}
