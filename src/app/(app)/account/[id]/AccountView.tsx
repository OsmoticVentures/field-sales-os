"use client";

import Link from "next/link";
import { useState } from "react";
import { apiFetch } from "../../../../lib/core/api";
import { Card, Ico, eyebrowCls } from "../../../../lib/core/ui";
import type { ClientAccount, ClientActivity, ClientContact } from "../../../../lib/features/clients/dal";
import {
  OpenBadge,
  PhoneDisplay,
  TierChip,
  absoluteUrl,
  outlookCompose,
  prettyPhone,
  prettyUrl,
  realLifecycle,
  withinTrailing12mo,
} from "../../../../lib/features/clients/ui";
import type { PurchaseLine, PurchaseOrder } from "../../../../lib/features/prospect/dal";
import { HUBSPOT_COMPANY_URL, daysAgo, money } from "../../../../lib/features/prospect/format";
import type { RouteDraftEntry } from "../../../../lib/features/route/types";

const POTENTIAL_LETTERS = ["A", "B", "C", "D", "E", "F", "G"] as const;

const press = "transition-transform active:scale-[0.97] motion-reduce:transition-none motion-reduce:active:scale-100";
const actionBtn = `inline-flex min-h-11 items-center gap-1.5 rounded-md border border-[#E2DFD5] bg-white px-3.5 py-2 text-[14px] font-medium text-[#3D4A44] hover:bg-[#FAF9F5] hover:text-[#14201B] ${press}`;
const absentBtn = "inline-flex min-h-11 items-center gap-1.5 rounded-md border border-dashed border-[#E2DFD5] px-3.5 py-2 text-[14px] text-[#A9AFA9]";

async function postJson(path: string, body: unknown): Promise<void> {
  const res = await apiFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify(body),
  });
  const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!res.ok || j.ok === false) throw new Error(j.error ?? "Could not save that.");
}

function PotentialGrade({ accountId, hq, juan }: { accountId: string; hq: string | null; juan: string | null }) {
  const [value, setValue] = useState<string | null>(juan);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const hqLetter = hq ? hq.split(" ")[0] || null : null;

  async function pick(t: string) {
    const prev = value;
    const next = value === t ? null : t;
    setValue(next);
    setPending(true);
    setFailed(false);
    try {
      await postJson("/api/prospect/account-fact", { account_id: accountId, field: "potential_juan", value: next });
    } catch {
      setValue(prev);
      setFailed(true);
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <div className={`mb-2.5 ${eyebrowCls}`}>Potential</div>
      {hqLetter && (
        <div className="flex items-center justify-between gap-3 text-[13px]">
          <span className="text-[#5B6560]">HQ grade</span>
          <TierChip tier={hqLetter} scale="hq" />
        </div>
      )}
      <div className={`${hqLetter ? "mt-3 " : ""}flex flex-wrap items-center justify-between gap-2`}>
        <span className="text-[13px] text-[#5B6560]">Your read</span>
        <div className="flex gap-1">
          {POTENTIAL_LETTERS.map((t) => {
            const active = value === t;
            return (
              <button
                key={t}
                type="button"
                disabled={pending}
                aria-pressed={active}
                onClick={() => pick(t)}
                className={`h-8 w-8 rounded text-[12px] font-semibold ${press} ${
                  active ? "bg-[#14201B] text-[#F7F6F1]" : "bg-[#ECEAE1] text-[#3D4A44] hover:bg-[#E2DFD5]"
                }`}
              >
                {t}
              </button>
            );
          })}
        </div>
      </div>
      {failed && <p className="mt-2 text-[12px] text-[#8A2E2E]">Not saved. Tap again.</p>}
    </Card>
  );
}

function AddToRoute({ accountId, day, entries }: { accountId: string; day: string | null; entries: RouteDraftEntry[] }) {
  const already = entries.some((e) => (typeof e === "string" ? e : e.id) === accountId);
  const [onRoute, setOnRoute] = useState(already);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!day) return null;

  async function add() {
    setBusy(true);
    setFailed(false);
    try {
      await postJson("/api/route/draft", { day, entries: [...entries, accountId] });
      setOnRoute(true);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  if (onRoute) {
    return (
      <Link href="/route" className={`inline-flex min-h-11 items-center gap-1.5 rounded-md bg-[#EEECE3] px-3.5 py-2 text-[14px] font-medium text-[#3D4A44] ${press}`}>
        <Ico name="check" size={14} />
        On the route
      </Link>
    );
  }
  return (
    <button
      type="button"
      onClick={add}
      disabled={busy}
      className={`inline-flex min-h-11 items-center gap-1.5 rounded-md bg-[#2C6A46] px-3.5 py-2 text-[14px] font-semibold text-white disabled:opacity-60 ${press}`}
    >
      <Ico name="route" size={14} />
      {failed ? "Try again" : "Add to route"}
    </button>
  );
}

function Purchases({ orders, lines }: { orders: PurchaseOrder[]; lines: PurchaseLine[] }) {
  const orderedAt = new Map(orders.map((o) => [o.id, o.ordered_at]));
  const totals = new Map<string, { qty: number; revenueCents: number; last: string | null }>();
  for (const l of lines) {
    const name = l.product_name ?? "Item";
    const prev = totals.get(name) ?? { qty: 0, revenueCents: 0, last: null };
    const at = orderedAt.get(l.order_id) ?? null;
    totals.set(name, {
      qty: prev.qty + (l.qty ?? 0),
      revenueCents: prev.revenueCents + l.line_revenue_cents,
      last: at && (!prev.last || at > prev.last) ? at : prev.last,
    });
  }
  const items = [...totals.entries()].filter(([, t]) => t.qty !== 0).sort((a, b) => b[1].qty - a[1].qty);

  return (
    <Card>
      <div className={`mb-3 flex items-baseline justify-between gap-3 ${eyebrowCls}`}>
        <span>Purchases</span>
        <span className="normal-case tracking-normal">
          {orders.length} order{orders.length === 1 ? "" : "s"}
        </span>
      </div>
      <ul className="flex flex-col divide-y divide-[#EDEBE3]">
        {items.map(([name, t]) => (
          <li key={name} className="flex items-baseline justify-between gap-3 py-1.5 text-[13.5px]">
            <span className="flex min-w-0 items-baseline gap-1.5">
              <span className="min-w-0 truncate">{name}</span>
              {withinTrailing12mo(t.last) && (
                <span className="shrink-0 rounded-full bg-[#B3452C] px-1.5 py-0.5 text-[9.5px] font-semibold tracking-wide text-white uppercase">
                  Recent
                </span>
              )}
            </span>
            <span className="shrink-0 tabular-nums text-[#5B6560]">
              ×{t.qty} <span className="text-[#8A928C]">· {money(t.revenueCents / 100)}</span>
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function AccountView({
  account: a,
  contacts,
  activities,
  orders,
  lines,
  routeDay,
  routeEntries,
}: {
  account: ClientAccount;
  contacts: ClientContact[];
  activities: ClientActivity[];
  orders: PurchaseOrder[];
  lines: PurchaseLine[];
  routeDay: string | null;
  routeEntries: RouteDraftEntry[];
}) {
  const hasSummary = a.current_state || a.future_state || a.impact;
  const channels = [
    a.email && { href: outlookCompose(a.email), label: a.email, icon: "mail" },
    a.instagram_url && { href: a.instagram_url, label: "Instagram", icon: "external" },
    a.facebook_url && { href: a.facebook_url, label: "Facebook", icon: "external" },
    a.linkedin_url && { href: a.linkedin_url, label: "LinkedIn", icon: "external" },
  ].filter(Boolean) as { href: string; label: string; icon: string }[];

  const stats = [
    ["State", realLifecycle(a.lifecycle)],
    ["Last order", a.last_order_at ? daysAgo(a.last_order_at) : "Never"],
    ["Lifetime", money(a.lifetime_revenue)],
    ["Trailing 12mo", money(a.trailing_12m_revenue)],
    ["Reorder due", a.expected_reorder_at],
  ].filter(([, v]) => v) as [string, string][];

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        {a.hubspot_company_id ? (
          <a
            href={HUBSPOT_COMPANY_URL(a.hubspot_company_id)}
            target="_blank"
            rel="noopener noreferrer"
            className={`inline-flex min-h-11 items-center gap-1.5 rounded-md bg-[#14201B] px-3.5 py-2 text-[14px] font-semibold text-[#F7F6F1] ${press}`}
          >
            <Ico name="hubspot" size={14} />
            Open in HubSpot
          </a>
        ) : (
          <span className={absentBtn}>
            <Ico name="hubspot" size={14} />
            No HubSpot record
          </span>
        )}
        {a.website ? (
          <a href={absoluteUrl(a.website)} target="_blank" rel="noreferrer" className={`${actionBtn} min-w-0`}>
            <Ico name="globe" size={14} />
            <span className="max-w-[26ch] truncate">{prettyUrl(a.website)}</span>
          </a>
        ) : (
          <span className={absentBtn}>
            <Ico name="globe" size={14} />
            No site on file
          </span>
        )}
        {a.phone ? (
          <a href={`tel:${a.phone}`} className={`${actionBtn} tabular-nums`}>
            <Ico name="phone" size={14} />
            {prettyPhone(a.phone)}
          </a>
        ) : (
          <span className={absentBtn}>
            <Ico name="phone" size={14} />
            No phone on file
          </span>
        )}
        <AddToRoute accountId={a.id} day={routeDay} entries={routeEntries} />
        <Link href="/visit" className={actionBtn}>
          <Ico name="plus" size={14} />
          Log a visit
        </Link>
      </div>

      <div className="grid min-w-0 gap-5 lg:grid-cols-[1fr_300px]">
        <div className="flex min-w-0 flex-col gap-5">
          {a.quirks && (
            <Card className="border-l-[3px] border-l-[#14201B]">
              <div className={`mb-1.5 flex items-center gap-2 ${eyebrowCls}`}>
                <Ico name="pin" size={13} />
                Field notes
              </div>
              <p className="text-[15px] leading-relaxed">{a.quirks}</p>
            </Card>
          )}

          {contacts.length > 0 && (
            <Card>
              <div className={`mb-3 ${eyebrowCls}`}>People</div>
              <ul className="flex flex-col gap-3">
                {contacts.map((c) => {
                  const name = [c.first_name, c.last_name].filter(Boolean).join(" ");
                  const role = c.title || (c.role_tag ? c.role_tag[0].toUpperCase() + c.role_tag.slice(1) : null);
                  const lead = name || role;
                  if (!lead) return null;
                  return (
                    <li key={c.id} className="flex flex-col gap-0.5 text-[14px]">
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                        <span className="font-medium">{lead}</span>
                        {name && role && <span className="text-[12.5px] text-[#8A928C]">{role}</span>}
                        {c.is_decision_maker && (
                          <span className="rounded bg-[#ECEAE1] px-1.5 py-0.5 text-[10.5px] font-medium tracking-wide text-[#3D4A44] uppercase">
                            Decision maker
                          </span>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[13px] text-[#5B6560]">
                        {c.email && (
                          <a href={outlookCompose(c.email)} target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline">
                            {c.email}
                          </a>
                        )}
                        {c.phone && (
                          <a href={`tel:${c.phone}`} className="underline-offset-2 hover:underline">
                            {prettyPhone(c.phone)}
                          </a>
                        )}
                        {c.linkedin_url && (
                          <a href={c.linkedin_url} target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline">
                            LinkedIn
                          </a>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}

          {hasSummary && (
            <Card>
              <div className={`mb-3 ${eyebrowCls}`}>Summary</div>
              <dl className="flex flex-col gap-3 text-[14px]">
                {(
                  [
                    ["Now", a.current_state],
                    ["Opening", a.future_state],
                    ["Impact", a.impact],
                  ] as const
                ).map(([label, val]) =>
                  val ? (
                    <div key={label}>
                      <dt className="text-[12px] text-[#8A928C]">{label}</dt>
                      <dd className="mt-0.5 leading-relaxed">{val}</dd>
                    </div>
                  ) : null,
                )}
              </dl>
            </Card>
          )}

          {orders.length > 0 && <Purchases orders={orders} lines={lines} />}

          <section>
            <h2 className={`mb-3 ${eyebrowCls}`}>History</h2>
            {activities.length === 0 ? (
              <Card className="text-[14px] text-[#5B6560]">No activity logged.</Card>
            ) : (
              <ul className="divide-y divide-[#EDEBE3] overflow-hidden rounded-lg border border-[#E2DFD5] bg-white">
                {activities.map((t) => {
                  const note = t.detail ?? t.outcome?.replace(/_/g, " ");
                  return (
                    <li key={t.id} className="flex flex-col gap-1 px-4 py-3 text-[14px]">
                      <span className="flex items-baseline gap-3">
                        <span className="w-[86px] shrink-0 text-[12.5px] text-[#8A928C]">{daysAgo(t.at)}</span>
                        <span className="font-medium capitalize">{t.kind.replace(/_/g, " ")}</span>
                      </span>
                      {note && <p className="max-w-[68ch] whitespace-pre-wrap text-[#5B6560] sm:ml-[98px]">{note}</p>}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>

        <aside className="flex min-w-0 flex-col gap-4">
          <PotentialGrade accountId={a.id} hq={a.potential_hq} juan={a.potential_juan} />

          <Card>
            <dl className="grid grid-cols-2 gap-x-5 gap-y-4 text-[13.5px] lg:flex lg:flex-col lg:gap-2.5">
              {stats.map(([k, v]) => (
                <div key={k} className="flex min-w-0 flex-col gap-1 lg:flex-row lg:items-baseline lg:justify-between lg:gap-3">
                  <dt className="text-[11px] uppercase tracking-[0.08em] text-[#8A928C] lg:text-[13.5px] lg:normal-case lg:tracking-normal">{k}</dt>
                  <dd className="truncate text-[15px] font-semibold text-[#14201B] capitalize lg:text-right lg:text-[13.5px] lg:font-normal">{v}</dd>
                </div>
              ))}
              {a.phone && (
                <div className="col-span-2 flex items-center justify-between gap-3 border-t border-[#EDEBE3] pt-4 lg:pt-2.5">
                  <dt className="text-[11px] uppercase tracking-[0.08em] text-[#8A928C] lg:text-[13.5px] lg:normal-case lg:tracking-normal">Phone</dt>
                  <dd className="min-w-0">
                    <PhoneDisplay value={a.phone} />
                  </dd>
                </div>
              )}
            </dl>
          </Card>

          {channels.length > 0 && (
            <Card>
              <div className={`mb-2.5 ${eyebrowCls}`}>Channels</div>
              <ul className="flex flex-col gap-2">
                {channels.map((l) => (
                  <li key={l.label}>
                    <a
                      href={l.href}
                      target="_blank"
                      rel="noreferrer"
                      className="flex min-h-9 items-center gap-2 text-[13.5px] text-[#3D4A44] hover:text-[#14201B] hover:underline"
                    >
                      <Ico name={l.icon} size={14} />
                      <span className="truncate">{l.label}</span>
                    </a>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {a.business_hours && Object.keys(a.business_hours).length > 0 && (
            <Card>
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className={eyebrowCls}>Hours</div>
                <OpenBadge businessHours={a.business_hours} />
              </div>
              <dl className="flex flex-col gap-1 text-[13px]">
                {Object.entries(a.business_hours).map(([day, ranges]) => (
                  <div key={day} className="flex justify-between gap-3">
                    <dt className="w-9 shrink-0 text-[#8A928C] capitalize">{day}</dt>
                    <dd className="min-w-0 flex-1 text-right break-words tabular-nums">
                      {ranges.length ? ranges.map((r) => r.join(" to ")).join(", ") : "Closed"}
                    </dd>
                  </div>
                ))}
              </dl>
            </Card>
          )}
        </aside>
      </div>
    </div>
  );
}
