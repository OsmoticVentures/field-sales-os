/**
 * Display pieces for Clients and the client view, ported from the source
 * app's lib/ui.tsx (TierChip, Confidence, OpenBadge, PhoneDisplay and the
 * link helpers). Pure, usable from server and client components alike.
 */
import { hoursStatus, type BusinessHours } from "../prospect/hours";

export function TierChip({ tier, scale = "os" }: { tier: string | null; scale?: "os" | "hq" }) {
  if (!tier) return null;
  return (
    <span
      className={`inline-flex h-[21px] w-[21px] items-center justify-center rounded text-[12px] font-semibold ${
        tier === "A" ? "bg-[#14201B] text-[#F7F6F1]" : "bg-[#ECEAE1] text-[#3D4A44]"
      }`}
      title={scale === "hq" ? `HQ potential ${tier}` : `OS tier ${tier}`}
    >
      {tier}
    </span>
  );
}

export function Confidence({ value, known, total }: { value: number | null; known?: number | null; total?: number | null }) {
  const c = value ?? 0;
  const low = c < 0.5;
  return (
    <span className={`inline-flex items-baseline gap-1 text-[12px] ${low ? "text-[#A79878]" : "text-[#5B6560]"}`}>
      {known != null && total != null ? `${known} of ${total} inputs` : `${(c * 100).toFixed(0)}%`}
      {low && <span className="font-medium">· low</span>}
    </span>
  );
}

export function OpenBadge({ businessHours, dot }: { businessHours: BusinessHours | null | undefined; dot?: boolean }) {
  const status = hoursStatus(businessHours);
  if (!status) return null;
  if (dot) {
    return (
      <span
        className={`inline-block h-[7px] w-[7px] shrink-0 rounded-full ${status.open ? "bg-[#3D6B4A]" : "bg-[#B7ACA0]"}`}
        title={status.label}
      />
    );
  }
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium ${
        status.open ? "bg-[#E3EFE6] text-[#3D6B4A]" : "bg-[#ECEAE1] text-[#8A928C]"
      }`}
    >
      <span className={`h-[6px] w-[6px] rounded-full ${status.open ? "bg-[#3D6B4A]" : "bg-[#B7ACA0]"}`} />
      {status.label}
    </span>
  );
}

export function PhoneDisplay({ value }: { value: string | null }) {
  if (!value) return null;
  const m = value.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  if (!m) return <a href={`tel:${value}`} className="text-[17px] font-bold text-[#14201B]">{value}</a>;
  const [, area, mid, last] = m;
  return (
    <a href={`tel:${value}`} className="font-bold whitespace-nowrap text-[#14201B] transition-opacity hover:opacity-80">
      <span className="text-[13px]">+1</span> <span className="text-[21px] tracking-tight tabular-nums">{area}</span>
      <span className="mx-[3px] text-[13px]">-</span>
      <span className="text-[21px] tracking-tight tabular-nums">{mid}</span>
      <span className="mx-[3px] text-[13px]">-</span>
      <span className="text-[21px] tracking-tight tabular-nums">{last}</span>
    </a>
  );
}

export function prettyPhone(value: string): string {
  const m = value.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : value;
}

export function prettyUrl(value: string): string {
  return value.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "");
}

/** A stored site without a scheme would resolve as a path on this app. */
export function absoluteUrl(value: string): string {
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

export function realChannel(channel: string | null | undefined): string | null {
  return channel && channel !== "unknown" ? channel : null;
}

export function realLifecycle(lifecycle: string | null | undefined): string | null {
  return lifecycle && lifecycle !== "unknown" ? lifecycle : null;
}

export function withinTrailing12mo(iso: string | null): boolean {
  if (!iso) return false;
  return new Date(iso).getTime() >= Date.now() - 365 * 86_400_000;
}

export function outlookCompose(email: string): string {
  return `https://outlook.cloud.microsoft/mail/deeplink/compose?to=${encodeURIComponent(email)}`;
}
