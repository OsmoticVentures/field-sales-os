/**
 * Practice progress for the Prospect screen: which roadmap lines the rep has
 * drilled, kept on the phone only (localStorage, one key per rep).
 *
 * BOUND (AGENTS.md "bound every append"): one record per drill id in DRILLS,
 * never more. Ids that left DRILLS are dropped when the record is read, so
 * the store cannot outgrow the playbook. Nothing here leaves the phone.
 */
import { DRILLS, type Drill } from "./playbook.generated";

export type Answer = "again" | "got";
export type CardRec = { n: number; got: number; last: string; ans: Answer };
export type Practice = {
  cards: Record<string, CardRec>;
  /** Cards answered on one local day, for the set counter. */
  today: { date: string; n: number; got: number };
};

export const SET_SIZE = 5;

const keyFor = (rep: string | null) => `nb_practice:${rep ?? "_"}`;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const IDS = new Set(DRILLS.map((d) => d.id));

export function todayKey(): string {
  return new Date().toLocaleDateString("en-CA");
}

const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? Math.min(100_000, Math.max(0, Math.floor(v))) : 0);

export function emptyPractice(): Practice {
  return { cards: {}, today: { date: "", n: 0, got: 0 } };
}

export function loadPractice(rep: string | null): Practice {
  const out = emptyPractice();
  try {
    const raw = JSON.parse(localStorage.getItem(keyFor(rep)) ?? "null") as Partial<Practice> | null;
    if (!raw || typeof raw !== "object") return out;
    for (const [id, r] of Object.entries(raw.cards ?? {})) {
      const c = r as Partial<CardRec> | null;
      if (!IDS.has(id) || !c || typeof c !== "object") continue;
      out.cards[id] = {
        n: count(c.n),
        got: Math.min(count(c.got), count(c.n)),
        last: typeof c.last === "string" && DATE.test(c.last) ? c.last : "",
        ans: c.ans === "again" ? "again" : "got",
      };
    }
    const t = raw.today;
    if (t && typeof t.date === "string" && DATE.test(t.date)) out.today = { date: t.date, n: count(t.n), got: count(t.got) };
  } catch {
    /* an unreadable record starts fresh */
  }
  return out;
}

export function savePractice(rep: string | null, p: Practice): void {
  try {
    localStorage.setItem(keyFor(rep), JSON.stringify(p));
  } catch {
    /* storage full or blocked: the session still works, it just is not kept */
  }
}

export function doneToday(p: Practice, date: string): { n: number; got: number } {
  return p.today.date === date ? { n: p.today.n, got: p.today.got } : { n: 0, got: 0 };
}

export function record(p: Practice, id: string, ans: Answer, date: string): Practice {
  if (!IDS.has(id)) return p;
  const prev = p.cards[id];
  const t = doneToday(p, date);
  return {
    cards: {
      ...p.cards,
      [id]: { n: (prev?.n ?? 0) + 1, got: (prev?.got ?? 0) + (ans === "got" ? 1 : 0), last: date, ans },
    },
    today: { date, n: t.n + 1, got: t.got + (ans === "got" ? 1 : 0) },
  };
}

/** Marked Again first (oldest first), then never practiced (playbook order),
 *  then the rest, least recently practiced first. */
function order(p: Practice, pool: Drill[]): Drill[] {
  const rank = (d: Drill): number => {
    const c = p.cards[d.id];
    return !c ? 1 : c.ans === "again" ? 0 : 2;
  };
  const at = (d: Drill) => DRILLS.indexOf(d);
  return [...pool].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    const ca = p.cards[a.id];
    const cb = p.cards[b.id];
    if (ca && cb && ca.last !== cb.last) return ca.last < cb.last ? -1 : 1;
    if (ca && cb && ca.n !== cb.n) return ca.n - cb.n;
    return at(a) - at(b);
  });
}

/** The next cards to practice. Without a stage, cards already answered today
 *  wait for tomorrow unless nothing else is left. */
export function pick(p: Practice, date: string, take: number, stage: string | null): Drill[] {
  if (stage) return order(p, DRILLS.filter((d) => d.stage === stage)).slice(0, take);
  const fresh = DRILLS.filter((d) => p.cards[d.id]?.last !== date);
  const rest = DRILLS.filter((d) => p.cards[d.id]?.last === date);
  return [...order(p, fresh), ...order(p, rest)].slice(0, take);
}
