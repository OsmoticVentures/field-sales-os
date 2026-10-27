"use client";

/**
 * The six intelligence columns of the Prospect dashboard. Each takes the
 * slice of the payload it needs and renders nothing it has no data for: a
 * missing value is absent, never a placeholder.
 */
import { useState, type ReactNode } from "react";
import { Card } from "../../../lib/core/ui";
import type { IntelPayload, IntelRanked } from "../../../lib/features/prospect/intel";
import type { PlaybookStatus } from "../../../lib/features/prospect/playbook.generated";
import {
  ColumnTitle,
  Glyph,
  MoreToggle,
  SubTitle,
  channelGlyph,
  channelName,
  daysAgo,
  followupGlyph,
  openAccount,
  plainAhead,
  plainPast,
  pressCls,
  rowDivider,
  safeUrl,
  unrankedRow,
} from "./intel-ui";

const num = "[font-variant-numeric:tabular-nums]";
const cardCls = "p-4!";

/** A full-width tappable row that opens the account in the call list. */
function AccountRow({ row, children, label }: { row: IntelRanked; children: ReactNode; label?: string }) {
  return (
    <li className={rowDivider}>
      <button
        type="button"
        onClick={() => openAccount(row)}
        aria-label={label ?? `Open ${row.name}`}
        className={`-mx-2 flex min-h-11 w-[calc(100%+1rem)] items-start gap-3 rounded-md px-2 py-2.5 text-left ${pressCls}`}
      >
        {children}
      </button>
    </li>
  );
}

function rankedLookup(d: IntelPayload) {
  const byId = new Map(d.ranked.map((r) => [r.id, r]));
  return (id: string, name: string): IntelRanked => byId.get(id) ?? unrankedRow(id, name);
}

/* ------------------------------------------------------------------ */
/* Ranked                                                              */
/* ------------------------------------------------------------------ */

const RANKED_SHOWN = 8;

export function RankedColumn({ d }: { d: IntelPayload }) {
  const [all, setAll] = useState(false);
  const rows = all ? d.ranked : d.ranked.slice(0, RANKED_SHOWN);
  return (
    <Card className={cardCls}>
      <ColumnTitle title="Ranked" count={d.ranked.length} />
      <ul>
        {rows.map((r) => (
          <AccountRow key={r.id} row={r}>
            {r.score != null && (
              <span
                className={`mt-0.5 inline-flex h-7 min-w-9 shrink-0 items-center justify-center rounded-md px-1.5 text-[13px] font-semibold ${num} ${
                  r.band === "now" ? "bg-[#14201B] text-[#F7F6F1]" : "bg-[#EDEBE3] text-[#3D4A44]"
                }`}
              >
                {r.score}
              </span>
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14.5px] leading-snug font-medium text-[#14201B]">{r.name}</span>
              {r.reason && <span className="mt-0.5 line-clamp-2 block text-[12.5px] leading-snug text-[#5B6560]">{r.reason}</span>}
            </span>
          </AccountRow>
        ))}
      </ul>
      <MoreToggle open={all} hidden={d.ranked.length - RANKED_SHOWN} onToggle={() => setAll((v) => !v)} />
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Follow-ups                                                          */
/* ------------------------------------------------------------------ */

const FOLLOWUPS_SHOWN = 6;

function lateText(days: number, due: string): string {
  if (days > 1) return `${days} days late`;
  if (days === 1) return "1 day late";
  return plainAhead(due) === "today" ? "Due today" : `Due ${plainAhead(due) ?? ""}`.trim();
}

export function FollowupsColumn({ d }: { d: IntelPayload }) {
  const [all, setAll] = useState(false);
  const pick = rankedLookup(d);
  const rows = all ? d.followups : d.followups.slice(0, FOLLOWUPS_SHOWN);
  return (
    <Card className={cardCls}>
      <ColumnTitle title="Follow-ups" count={d.followups.length} />
      <ul>
        {rows.map((f) => {
          const body = (
            <>
              <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#F1EFE7] text-[#5B6560]">
                <Glyph name={followupGlyph(f.kind)} size={15} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0 truncate text-[14.5px] leading-snug font-medium text-[#14201B]">{f.name}</span>
                  <span
                    className={`shrink-0 text-[12px] ${num} ${
                      f.overdueDays >= 14 ? "rounded-full bg-[#F3E3C6] px-2 py-0.5 font-medium text-[#8A6D2F]" : "text-[#8A928C]"
                    }`}
                  >
                    {lateText(f.overdueDays, f.due)}
                  </span>
                </span>
                {f.why && <span className="mt-0.5 line-clamp-2 block text-[12.5px] leading-snug text-[#5B6560]">{f.why}</span>}
              </span>
            </>
          );
          return f.accountId ? (
            <AccountRow key={f.id} row={pick(f.accountId, f.name)}>
              {body}
            </AccountRow>
          ) : (
            <li key={f.id} className={`${rowDivider} flex items-start gap-3 py-2.5`}>
              {body}
            </li>
          );
        })}
      </ul>
      <MoreToggle open={all} hidden={d.followups.length - FOLLOWUPS_SHOWN} onToggle={() => setAll((v) => !v)} />
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Sequences                                                           */
/* ------------------------------------------------------------------ */

const SEQUENCES_SHOWN = 5;
const CHAIN_MAX = 8;
const NEXT_LABEL: Record<string, string> = { call: "Call", visit: "Visit", callback: "Callback" };

export function SequencesColumn({ d }: { d: IntelPayload }) {
  const [all, setAll] = useState(false);
  const pick = rankedLookup(d);
  const rows = all ? d.sequences : d.sequences.slice(0, SEQUENCES_SHOWN);
  return (
    <Card className={cardCls}>
      <ColumnTitle title="Sequences" count={d.sequences.length} />
      <ul>
        {rows.map((s) => {
          const steps = s.steps.slice(-CHAIN_MAX);
          const earlier = s.steps.length - steps.length;
          const nextDate = s.next ? plainAhead(s.next.date) : null;
          return (
            <AccountRow key={s.accountId} row={pick(s.accountId, s.name)}>
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0 truncate text-[14.5px] leading-snug font-medium text-[#14201B]">{s.name}</span>
                  <span className={`shrink-0 text-[12px] text-[#8A928C] ${num}`}>{daysAgo(s.daysSinceLast)}</span>
                </span>
                <span
                  className="mt-1.5 flex items-center"
                  role="img"
                  aria-label={`Touches in order: ${s.steps.map((x) => channelName(x.kind)).join(", ")}`}
                >
                  {earlier > 0 && <span className={`mr-1.5 text-[11.5px] text-[#8A928C] ${num}`}>+{earlier}</span>}
                  {steps.map((st, i) => (
                    <span key={`${st.at}-${i}`} className="flex items-center">
                      {i > 0 && <span className="h-px w-1.5 bg-[#D8D4C8]" />}
                      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[#F1EFE7] text-[#5B6560]">
                        <Glyph name={channelGlyph(st.kind)} size={13} />
                      </span>
                    </span>
                  ))}
                </span>
                {s.next && nextDate && (
                  <span className="mt-1.5 block text-[12.5px] text-[#5B6560]">
                    Next: {(NEXT_LABEL[s.next.kind] ?? s.next.kind).toLowerCase()} <span className={`text-[#14201B] ${num}`}>{nextDate}</span>
                  </span>
                )}
              </span>
            </AccountRow>
          );
        })}
      </ul>
      <MoreToggle open={all} hidden={d.sequences.length - SEQUENCES_SHOWN} onToggle={() => setAll((v) => !v)} />
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Scan                                                                */
/* ------------------------------------------------------------------ */

const GRADE_FILL: Record<string, string> = { A: "#14201B", B: "#3D4A44", C: "#8A928C", D: "#CFCBBD" };
const GRADE_CHIP: Record<string, string> = {
  A: "bg-[#14201B] text-[#F7F6F1]",
  B: "bg-[#3D4A44] text-[#F7F6F1]",
  C: "bg-[#EDEBE3] text-[#3D4A44]",
  D: "bg-[#EDEBE3] text-[#5B6560]",
};

function GradeChip({ grade }: { grade: string }) {
  return (
    <span
      className={`mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[12.5px] font-semibold ${GRADE_CHIP[grade] ?? "bg-[#EDEBE3] text-[#5B6560]"}`}
    >
      {grade}
    </span>
  );
}

const LEADS_SHOWN = 4;

export function ScanColumn({ d }: { d: IntelPayload }) {
  const [all, setAll] = useState(false);
  const pick = rankedLookup(d);
  const s = d.scan;
  const last = plainPast(s.lastScanAt);
  const newTotal = s.new14.reduce((n, x) => n + x.count, 0);
  const newMax = Math.max(1, ...s.new14.map((x) => x.count));
  const gradeTotal = s.scoutGrades.reduce((n, x) => n + x.count, 0);
  const fitTotal = s.dormantFit.good + s.dormantFit.notFit;
  const leads = all ? s.awaitingFirstTouch : s.awaitingFirstTouch.slice(0, LEADS_SHOWN);

  return (
    <Card className={cardCls}>
      <ColumnTitle
        title="Scan"
        aside={last ? <span className={`text-[12.5px] text-[#8A928C] ${num}`}>Scanned {last}</span> : undefined}
      />

      {s.new14.length > 0 && (
        <section className="mb-5">
          <SubTitle aside={<span className={`text-[13px] font-semibold text-[#14201B] ${num}`}>{newTotal}</span>}>New leads, 14 days</SubTitle>
          <ul className="flex flex-col gap-2.5">
            {s.new14.map((x) => (
              <li key={x.source}>
                <div className="flex items-baseline justify-between text-[13.5px]">
                  <span className="text-[#14201B]">{x.source}</span>
                  <span className={`text-[#5B6560] ${num}`}>{x.count}</span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[#EDEBE3]">
                  <div className="h-full rounded-full bg-[#14201B]" style={{ width: `${Math.max(3, (x.count / newMax) * 100)}%` }} />
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {gradeTotal > 0 && (
        <section className="mb-5">
          <SubTitle>Scout grades</SubTitle>
          <div
            className="flex h-2.5 gap-px overflow-hidden rounded-full"
            role="img"
            aria-label={`Scout grades: ${s.scoutGrades.map((g) => `${g.count} grade ${g.grade}`).join(", ")}`}
          >
            {s.scoutGrades.map((g) => (
              <div key={g.grade} style={{ flexGrow: g.count, flexBasis: 0, background: GRADE_FILL[g.grade] ?? "#CFCBBD" }} />
            ))}
          </div>
          <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
            {s.scoutGrades.map((g) => (
              <li key={g.grade} className="flex items-center gap-1.5 text-[12.5px] text-[#5B6560]">
                <span className="h-2 w-2 rounded-sm" style={{ background: GRADE_FILL[g.grade] ?? "#CFCBBD" }} />
                {g.grade} <span className={`text-[#14201B] ${num}`}>{g.count}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {fitTotal > 0 && (
        <section className="mb-5">
          <SubTitle>Dormant accounts</SubTitle>
          <div className="flex h-2.5 gap-px overflow-hidden rounded-full" role="img" aria-label={`${s.dormantFit.good} good fit, ${s.dormantFit.notFit} not a fit`}>
            <div className="bg-[#2C6A46]" style={{ flexGrow: s.dormantFit.good, flexBasis: 0 }} />
            <div className="bg-[#CFCBBD]" style={{ flexGrow: s.dormantFit.notFit, flexBasis: 0 }} />
          </div>
          <div className="mt-2 flex gap-x-5 text-[12.5px] text-[#5B6560]">
            <span>
              Good fit <span className={`font-medium text-[#14201B] ${num}`}>{s.dormantFit.good}</span>
            </span>
            <span>
              Not a fit <span className={`font-medium text-[#14201B] ${num}`}>{s.dormantFit.notFit}</span>
            </span>
          </div>
        </section>
      )}

      {s.awaitingFirstTouch.length > 0 && (
        <section>
          <SubTitle aside={<span className={`text-[13px] font-semibold text-[#14201B] ${num}`}>{s.awaitingFirstTouch.length}</span>}>
            Awaiting first touch
          </SubTitle>
          <ul>
            {leads.map((l) => {
              const meta = [l.business, l.city].filter(Boolean).join(" in ");
              return (
                <AccountRow key={l.id} row={pick(l.id, l.name)}>
                  {l.grade && <GradeChip grade={l.grade} />}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14.5px] leading-snug font-medium text-[#14201B]">{l.name}</span>
                    {meta && <span className="mt-0.5 block truncate text-[12.5px] leading-snug text-[#5B6560]">{meta}</span>}
                  </span>
                </AccountRow>
              );
            })}
          </ul>
          <MoreToggle open={all} hidden={s.awaitingFirstTouch.length - LEADS_SHOWN} onToggle={() => setAll((v) => !v)} />
        </section>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Socials                                                             */
/* ------------------------------------------------------------------ */

const SOCIAL_SHOWN = 5;
const NETWORKS = [
  { key: "instagram", label: "Instagram" },
  { key: "facebook", label: "Facebook" },
  { key: "linkedin", label: "LinkedIn" },
] as const;

export function SocialsColumn({ d }: { d: IntelPayload }) {
  const [all, setAll] = useState(false);
  const pick = rankedLookup(d);
  const s = d.socials;
  const withLinks = s.top.filter((t) => safeUrl(t.instagram) || safeUrl(t.facebook) || safeUrl(t.linkedin));
  const rows = all ? withLinks : withLinks.slice(0, SOCIAL_SHOWN);
  return (
    <Card className={cardCls}>
      <ColumnTitle title="Socials" />
      {s.book > 0 && (
        <ul className="mb-5 flex flex-col gap-3">
          {NETWORKS.map((n) => (
            <li key={n.key}>
              <div className="flex items-center justify-between text-[13.5px]">
                <span className="flex items-center gap-2 text-[#14201B]">
                  <span className="text-[#5B6560]">
                    <Glyph name={n.key} size={16} />
                  </span>
                  {n.label}
                </span>
                <span className={`text-[#5B6560] ${num}`}>
                  <span className="font-semibold text-[#14201B]">{s[n.key]}</span> of {s.book}
                </span>
              </div>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-[#EDEBE3]">
                <div className="h-full rounded-full bg-[#14201B]" style={{ width: `${Math.max(2, (s[n.key] / s.book) * 100)}%` }} />
              </div>
            </li>
          ))}
        </ul>
      )}
      {withLinks.length > 0 && (
        <section>
          <SubTitle>Ranked accounts</SubTitle>
          <ul>
            {rows.map((t) => (
              <li key={t.id} className={`${rowDivider} flex items-center gap-1`}>
                <button
                  type="button"
                  onClick={() => openAccount(pick(t.id, t.name))}
                  aria-label={`Open ${t.name}`}
                  className={`-ml-2 flex min-h-11 min-w-0 flex-1 items-center rounded-md px-2 text-left ${pressCls}`}
                >
                  <span className="truncate text-[14.5px] font-medium text-[#14201B]">{t.name}</span>
                </button>
                <span className="-mr-2 flex shrink-0">
                  {NETWORKS.map((n) => {
                    const href = safeUrl(t[n.key]);
                    if (!href) return null;
                    return (
                      <a
                        key={n.key}
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`${n.label} for ${t.name}`}
                        className={`flex h-11 w-11 items-center justify-center rounded-md text-[#5B6560] ${pressCls}`}
                      >
                        <Glyph name={n.key} size={19} />
                      </a>
                    );
                  })}
                </span>
              </li>
            ))}
          </ul>
          <MoreToggle open={all} hidden={withLinks.length - SOCIAL_SHOWN} onToggle={() => setAll((v) => !v)} />
        </section>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Playbook                                                            */
/* ------------------------------------------------------------------ */

export const STATUS: Record<PlaybookStatus, { label: string; chip: string; fill: string }> = {
  tested: { label: "Field-tested", chip: "bg-[#E1EDE5] text-[#2C6A46]", fill: "#2C6A46" },
  partial: { label: "Partial", chip: "bg-[#F3E3C6] text-[#8A6D2F]", fill: "#D9B976" },
  derived: { label: "Derived", chip: "bg-[#EDEBE3] text-[#5B6560]", fill: "#B9BDB5" },
  proposed: { label: "Proposed", chip: "bg-white text-[#5B6560] ring-1 ring-inset ring-[#D8D4C8]", fill: "#DAD6C9" },
  untested: { label: "Untested", chip: "bg-[#F7F6F1] text-[#8A928C] ring-1 ring-inset ring-[#E2DFD5]", fill: "#E6E3D8" },
  todo: { label: "To write", chip: "bg-[#14201B] text-[#F7F6F1]", fill: "#14201B" },
};

export function PlaybookColumn({ d }: { d: IntelPayload }) {
  const p = d.playbook;
  const total = p.sections.length;
  const todos = p.sections.reduce((n, s) => n + s.todos, 0);
  const leadIdx = p.sections.findIndex((s) => /lead with/i.test(s.title));
  const showStores = p.storeTypes.length > 0 || p.conversations30 > 0;
  const convMax = Math.max(1, ...p.storeTypes.map((t) => t.conversations));

  const stores = showStores && (
    <div className="mb-1 ml-[34px] border-l-2 border-[#EDEBE3] pb-2 pl-3">
      <SubTitle>In-person conversations</SubTitle>
      {p.storeTypes.length > 0 && (
        <ul className="flex flex-col gap-2.5">
          {p.storeTypes.map((t) => (
            <li key={t.type}>
              <div className="flex items-baseline justify-between gap-2 text-[13.5px]">
                <span className="min-w-0 truncate text-[#14201B]">{t.type}</span>
                <span className={`shrink-0 text-[#5B6560] ${num}`}>
                  <span className="font-semibold text-[#14201B]">{t.conversations}</span> conversations
                </span>
              </div>
              <div className="mt-1 flex items-center gap-2.5">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[#EDEBE3]">
                  <div className="h-full rounded-full bg-[#14201B]" style={{ width: `${Math.max(3, (t.conversations / convMax) * 100)}%` }} />
                </div>
                <span className={`shrink-0 text-[12px] text-[#8A928C] ${num}`}>
                  {t.accounts} {t.accounts === 1 ? "account" : "accounts"}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
      {p.conversations30 > 0 && (
        <p className="mt-3 text-[13px] text-[#5B6560]">
          <span className={`font-semibold text-[#14201B] ${num}`}>{p.conversations30}</span> conversations logged in 30 days
        </p>
      )}
    </div>
  );

  return (
    <Card className={cardCls}>
      <ColumnTitle title="Playbook" />

      <div className="mb-4 rounded-md bg-[#F7F6F1] p-3">
        <div className="flex items-end justify-between gap-3">
          <p className="text-[13.5px] text-[#5B6560]">
            <span className={`mr-1 text-[30px] leading-none font-semibold tracking-[-0.02em] text-[#14201B] ${num}`}>{p.tested}</span>
            of <span className={num}>{total}</span> field-tested
          </p>
          {todos > 0 && (
            <span className={`pb-0.5 text-[12.5px] text-[#5B6560] ${num}`}>
              <span className="font-semibold text-[#14201B]">{todos}</span> TODO {todos === 1 ? "marker" : "markers"}
            </span>
          )}
        </div>
        <div
          className="mt-3 flex h-2 gap-0.5"
          role="img"
          aria-label={`${p.tested} of ${total} sections field-tested`}
        >
          {p.sections.map((s) => (
            <div key={s.n} className="flex-1 rounded-full" style={{ background: STATUS[s.status]?.fill ?? "#E6E3D8" }} />
          ))}
        </div>
      </div>

      <ol>
        {p.sections.map((s, i) => {
          const st = STATUS[s.status];
          return (
            <li key={s.n}>
              <div className={`${i > 0 ? "border-t border-[#EDEBE3]" : ""} flex min-h-11 items-start gap-3 py-2.5`}>
                <span className={`w-[22px] shrink-0 pt-px text-right text-[13px] text-[#8A928C] ${num}`}>{s.n}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[14.5px] leading-snug font-medium text-[#14201B]">{s.title}</span>
                  {s.todos > 0 && (
                    <span className={`mt-0.5 block text-[12px] text-[#8A928C] ${num}`}>
                      {s.todos} TODO {s.todos === 1 ? "marker" : "markers"}
                    </span>
                  )}
                </span>
                {st && <span className={`mt-px shrink-0 rounded-full px-2.5 py-1 text-[11.5px] leading-none font-medium whitespace-nowrap ${st.chip}`}>{st.label}</span>}
              </div>
              {i === leadIdx && stores}
            </li>
          );
        })}
      </ol>
      {leadIdx < 0 && stores}
    </Card>
  );
}
