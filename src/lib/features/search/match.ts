/**
 * Account reconciliation for the Places search, ported from
 * bridges/nutribiotic/match.py. PROPOSES a match, never writes. Phone and
 * street number + postal are decisive; name similarity is a tiebreaker only.
 * name_score() is Python's difflib.SequenceMatcher(None, a, b).ratio(),
 * ported below so the two stay numerically identical.
 */

const CHAIN_TOKENS = [
  "whole foods", "trader joe", "sprouts", "erewhon", "vitamin shoppe", "gnc",
  "natural grocers", "lassens", "mothers market", "co-opportunity", "cvs",
  "walgreens", "ralphs", "vons", "albertsons", "smart final", "grocery outlet",
];

const NOISE =
  /\b(inc|llc|ltd|corp|co|company|the|and|market|markets|mkt|store|shop|natural|foods|food|nutrition|health|supplements|vitamins|wellness)\b/g;

export function normName(s: string | null | undefined): string {
  if (!s) return "";
  let t = s.toLowerCase().trim();
  t = t.replace(/[^a-z0-9\s]/g, " ");
  t = t.replace(/\s+/g, " ");
  return t.trim();
}

function coreName(s: string | null | undefined): string {
  return normName(s).replace(NOISE, " ").replace(/\s+/g, " ").trim();
}

/** Last 10 digits, or "" when there aren't 10. */
export function normPhone(s: string | null | undefined): string {
  if (!s) return "";
  let d = String(s).replace(/\D/g, "");
  if (d.length > 10) d = d.slice(-10);
  return d.length === 10 ? d : "";
}

function streetNumber(s: string | null | undefined): string {
  if (!s) return "";
  const m = /^\s*(\d+)/.exec(s.trim());
  return m ? m[1] : "";
}

function normPostal(s: unknown): string {
  if (s == null || s === "") return "";
  const d = String(s).replace(/\D/g, "");
  return d.length >= 5 ? d.slice(0, 5) : "";
}

function isChain(name: string | null | undefined): boolean {
  const n = normName(name);
  return CHAIN_TOKENS.some((t) => n.includes(t));
}

/** difflib.SequenceMatcher(None, a, b).ratio(), including its autojunk rule. */
export function seqRatio(a: string, b: string): number {
  const la = a.length;
  const lb = b.length;
  const b2j = new Map<string, number[]>();
  for (let j = 0; j < lb; j++) {
    const ch = b[j];
    const list = b2j.get(ch);
    if (list) list.push(j);
    else b2j.set(ch, [j]);
  }
  if (lb >= 200) {
    const ntest = Math.floor(lb / 100) + 1;
    for (const [ch, idxs] of [...b2j]) if (idxs.length > ntest) b2j.delete(ch);
  }

  // No isjunk function, so the junk-extension passes never fire; the
  // non-junk extension passes still walk over "popular" chars removed above.
  const longest = (alo: number, ahi: number, blo: number, bhi: number): [number, number, number] => {
    let besti = alo;
    let bestj = blo;
    let bestsize = 0;
    let j2len = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const newj2len = new Map<number, number>();
      for (const j of b2j.get(a[i]) ?? []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) ?? 0) + 1;
        newj2len.set(j, k);
        if (k > bestsize) {
          besti = i - k + 1;
          bestj = j - k + 1;
          bestsize = k;
        }
      }
      j2len = newj2len;
    }
    while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) {
      besti--;
      bestj--;
      bestsize++;
    }
    while (besti + bestsize < ahi && bestj + bestsize < bhi && a[besti + bestsize] === b[bestj + bestsize]) {
      bestsize++;
    }
    return [besti, bestj, bestsize];
  };

  let matched = 0;
  const queue: [number, number, number, number][] = [[0, la, 0, lb]];
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop()!;
    const [i, j, k] = longest(alo, ahi, blo, bhi);
    if (k) {
      matched += k;
      if (alo < i && blo < j) queue.push([alo, i, blo, j]);
      if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
    }
  }
  const total = la + lb;
  return total ? (2 * matched) / total : 1;
}

function nameScore(a: string | null | undefined, b: string | null | undefined): number {
  const ca = coreName(a);
  const cb = coreName(b);
  if (!ca || !cb) return 0;
  return seqRatio(ca, cb);
}

/** Python's round(x, n) for the values this module produces. */
export function pyRound(x: number, n: number): number {
  return Number(x.toFixed(n));
}

/** Python's str(float): an integral float keeps its ".0". */
export function pyFloat(x: number): string {
  return Number.isInteger(x) ? x.toFixed(1) : String(x);
}

export type MatchRow = {
  id?: string | null;
  name?: string | null;
  phone?: string | null;
  street?: string | null;
  postal?: string | number | null;
  city?: string | null;
};

export type MatchResult = {
  decision_hint: "merge" | "review" | "create";
  account_id: string | null;
  account_name?: string | null;
  score: number;
  basis: Record<string, unknown>;
  why: string;
};

export function matchAccount(row: MatchRow, candidates: MatchRow[]): MatchResult {
  const rPhone = normPhone(row.phone);
  const rNum = streetNumber(row.street);
  const rPost = normPostal(row.postal);
  const rName = row.name;
  const rChain = isChain(rName);

  let best: {
    account_id: string | null;
    account_name: string | null;
    score: number;
    basis: Record<string, unknown>;
    decisive: boolean;
  } | null = null;

  for (const c of candidates) {
    const cPhone = normPhone(c.phone);
    const cNum = streetNumber(c.street);
    const cPost = normPostal(c.postal);

    const basis: Record<string, unknown> = {};
    let score = 0;
    let decisive = false;

    if (rPhone && cPhone && rPhone === cPhone) {
      basis.phone = "exact";
      score += 0.6;
      decisive = true;
    }
    if (rNum && cNum && rPost && cPost && rNum === cNum && rPost === cPost) {
      basis.address = "exact street number + postal";
      score += 0.55;
      decisive = true;
    } else if (rPost && cPost && rPost === cPost) {
      basis.postal = "same postal";
      score += 0.1;
    }
    const ns = nameScore(rName, c.name);
    if (ns > 0) {
      basis.name = pyRound(ns, 3);
      score += Math.min(ns, 1) * 0.25;
    }
    if (rChain && !decisive) {
      basis.chain_penalty = "chain name without address/phone corroboration";
      score *= 0.35;
    }
    // Compared against the ROUNDED best, exactly as match.py does.
    if (best === null || score > best.score) {
      best = { account_id: c.id ?? null, account_name: c.name ?? null, score: pyRound(score, 3), basis, decisive };
    }
  }

  if (best && rChain && "chain_penalty" in best.basis && ("postal" in best.basis || "name" in best.basis)) {
    return {
      decision_hint: "review",
      account_id: best.account_id,
      account_name: best.account_name,
      score: best.score,
      basis: best.basis,
      why:
        "chain name. Could be this location or a different branch, and the record has no phone or street number to tell them apart. Never auto-merged, never silently created.",
    };
  }
  if (best === null || best.score < 0.25) {
    return {
      decision_hint: "create",
      account_id: null,
      score: best ? pyRound(best.score, 3) : 0,
      basis: best ? best.basis : {},
      why: "no candidate scored above the floor",
    };
  }
  let hint: MatchResult["decision_hint"];
  let why: string;
  if (best.decisive) {
    hint = "merge";
    why =
      "decisive evidence: " +
      Object.entries(best.basis)
        .filter(([k]) => k === "phone" || k === "address")
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
  } else if (best.score >= 0.45) {
    hint = "review";
    why = "suggestive but not decisive, a human must confirm";
  } else {
    hint = "create";
    why = "weak similarity only, most likely a new account";
  }
  return { decision_hint: hint, account_id: best.account_id, account_name: best.account_name, score: best.score, basis: best.basis, why };
}
