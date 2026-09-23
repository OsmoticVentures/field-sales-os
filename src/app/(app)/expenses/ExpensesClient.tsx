"use client";

/**
 * Expenses, from the browser. Three cards: a photo drop zone that auto-sorts
 * what it's handed (odometer vs receipt vs bank-statement screenshot), a
 * link to the pay period's live sheet, and clock in/out with a break in
 * minutes. Every filing writes to the same Drive/Sheets tree the CLI's
 * `expensos` skill does, see lib/shared/expenses.ts.
 *
 * Ported from the NutriBiotic OS
 * (portfolio/src/app/nutribiotic/expenses/ExpensesClient.tsx). Business
 * logic (classification handling, date detection, pairing, filing) is
 * unchanged; each write now carries an Idempotency-Key so a retry never
 * files twice (PORTING.md).
 *
 * AUTO-SORT IS A SUGGESTION, NEVER A SILENT SUBMIT. Every field the
 * classifier proposes lands in an editable field. Filing is always a
 * deliberate tap.
 */

import { useEffect, useRef, useState } from "react";
import { Card, Ico, SuccessNote } from "../../../lib/core/ui";

type Summary = { period: string; label: string; sheetLink: string } | null;

type PhotoType = "odometer" | "receipt" | "statement" | "unsure";

type PhotoCard = {
  id: string;
  file: File;
  previewUrl: string;
  status: "classifying" | "ready" | "filing" | "filed" | "error" | "paired";
  type: PhotoType;
  message?: string;
  merchant: string;
  purpose: string;
  amount: string;
  companyCard: boolean;
  // The date printed on a receipt, when legible; feeds the shared filing
  // date below, never shown or edited on the card itself.
  ocrDate?: string;
  odo: string;
};

function todayPT(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
}

/** A file's own last-modified stamp, read in Pacific local time: when the
 *  photo reached the phone, used only to guess which calendar day a batch
 *  belongs to, never a time. */
function fileDatePT(file: File): string {
  return new Date(file.lastModified).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
}

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return Math.random().toString(36).slice(2, 10);
}

const inputCls =
  "w-full rounded-md border border-[#E2DFD5] bg-[#FAF9F5] px-2.5 py-2 text-[13px] text-[#14201B] placeholder:text-[#A9AFA9] focus:border-[#14201B] focus:outline-none";
const labelCls = "mb-1 block text-[11px] uppercase tracking-[0.1em] text-[#8A928C]";
const primaryBtn =
  "rounded-md bg-[#14201B] px-3.5 py-2.5 text-[13px] font-medium text-[#F7F6F1] transition-transform active:scale-[0.97] disabled:opacity-40 disabled:active:scale-100";
const ghostBtn =
  "rounded-md border border-[#E2DFD5] px-3 py-2 text-[12.5px] text-[#5B6560] transition-transform active:scale-[0.97] disabled:opacity-40";

export function ExpensesClient() {
  const [summary, setSummary] = useState<Summary>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/expenses/summary")
      .then((r) => r.json())
      .then((j) => (j.ok ? setSummary({ period: j.period, label: j.label, sheetLink: j.sheetLink }) : setSummaryError(j.error)))
      .catch(() => setSummaryError("Could not reach the expenses API."));
  }, []);

  return (
    <div className="flex flex-col gap-5">
      <ReviewCard summary={summary} error={summaryError} />
      <PhotosCard />
      <HoursCard />
    </div>
  );
}

function ReviewCard({ summary, error }: { summary: Summary; error: string | null }) {
  return (
    <Card className="flex items-center justify-between gap-4">
      <div>
        <div className="text-[11px] uppercase tracking-[0.14em] text-[#8A928C]">Current pay period</div>
        <div className="mt-1 text-[17px] font-semibold tracking-tight">
          {summary?.label ?? (error ? "Unavailable" : "Loading...")}
        </div>
        {error && <div className="mt-1 text-[12px] text-[#8A2E2E]">{error}</div>}
      </div>
      {summary && (
        <a href={summary.sheetLink} target="_blank" rel="noopener noreferrer" className={`${primaryBtn} flex shrink-0 items-center gap-1.5`}>
          <Ico name="external" size={13} />
          Open the sheet
        </a>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// photos: one drop zone, it sorts, pairs, dates, and files
// ---------------------------------------------------------------------------

function PhotosCard() {
  const [cards, setCards] = useState<PhotoCard[]>([]);
  // null = follow the auto-detected date; a string = an override, held until
  // "auto" is tapped again.
  const [manualDate, setManualDate] = useState<string | null>(null);
  const [tripPurpose, setTripPurpose] = useState("Client visits");
  const [dragOver, setDragOver] = useState(false);
  const [filingAll, setFilingAll] = useState(false);
  const [batchMessage, setBatchMessage] = useState<{ kind: "ok" | "warn"; text: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function onFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const fresh: PhotoCard[] = Array.from(files).map((file) => ({
      id: newId(),
      file,
      previewUrl: URL.createObjectURL(file),
      status: "classifying",
      type: "unsure",
      merchant: "",
      purpose: "",
      amount: "",
      companyCard: false,
      odo: "",
    }));
    setCards((prev) => [...fresh, ...prev]);
    setBatchMessage(null);
    fresh.forEach(classify);
  }

  async function classify(card: PhotoCard) {
    try {
      const form = new FormData();
      form.append("photo", card.file);
      const res = await fetch("/api/expenses/classify", { method: "POST", body: form });
      const j = await res.json();
      if (!j.ok) {
        update(card.id, { status: "error", message: j.error });
        return;
      }
      const s = j.suggestion;
      // A fixed vocabulary, never an invented reason: a meal is always
      // "Lunch, <what it was>", parking is always "Parking[, city]". Any
      // other category is left blank rather than guessed.
      let purpose = "";
      if (s.category === "meals" && s.item_summary) purpose = `Lunch, ${s.item_summary}`;
      else if (s.category === "parking") purpose = s.city ? `Parking, ${s.city}` : "Parking";
      update(card.id, {
        status: "ready",
        type: s.photo_type,
        merchant: s.merchant ?? "",
        amount: s.amount ?? "",
        ocrDate: s.date ?? undefined,
        odo: s.odometer_reading ?? "",
        purpose,
        message: s.confidence === "low" ? "Low confidence, check every field." : undefined,
      });
    } catch {
      update(card.id, { status: "error", message: "Could not classify. Pick a type by hand." });
    }
  }

  function update(id: string, patch: Partial<PhotoCard>) {
    setCards((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }

  function remove(id: string) {
    setCards((prev) => prev.filter((c) => c.id !== id));
  }

  // ONE date for the whole batch, never per photo: a receipt's printed date
  // wins if there is one, otherwise the file time on whichever odometer
  // photo read the lower number (the morning of the drive), otherwise today.
  function detectDate(): string {
    const dated = cards.find((c) => c.type === "receipt" && c.ocrDate);
    if (dated?.ocrDate) return dated.ocrDate;
    const odo = cards.filter((c) => c.type === "odometer" && c.odo && !Number.isNaN(Number(c.odo)));
    if (odo.length > 0) {
      const lowest = odo.reduce((a, b) => (Number(a.odo) <= Number(b.odo) ? a : b));
      return fileDatePT(lowest.file);
    }
    return todayPT();
  }
  const dateOverridden = manualDate !== null;
  const batchDate = manualDate ?? detectDate();

  async function fileReceipt(card: PhotoCard): Promise<boolean> {
    update(card.id, { status: "filing" });
    const form = new FormData();
    form.append("photo", card.file);
    form.append("date", batchDate);
    form.append("merchant", card.merchant);
    form.append("purpose", card.purpose);
    form.append("amount", card.amount);
    form.append("companyCard", String(card.companyCard));
    try {
      const res = await fetch("/api/expenses/receipt", {
        method: "POST",
        headers: { "Idempotency-Key": card.id },
        body: form,
      });
      const j = await res.json();
      if (!j.ok) {
        update(card.id, { status: "ready", message: j.error });
        return false;
      }
      update(card.id, { status: "filed" });
      setTimeout(() => remove(card.id), 1200);
      return true;
    } catch {
      update(card.id, { status: "ready", message: "Network error." });
      return false;
    }
  }

  async function fileTripPair(start: PhotoCard, end: PhotoCard, purpose: string): Promise<boolean> {
    update(start.id, { status: "filing" });
    update(end.id, { status: "filing" });
    const form = new FormData();
    form.append("start_photo", start.file);
    form.append("end_photo", end.file);
    form.append("date", batchDate);
    form.append("end_date", batchDate);
    form.append("start_odo", start.odo);
    form.append("end_odo", end.odo);
    form.append("purpose", purpose);
    try {
      const res = await fetch("/api/expenses/trip", {
        method: "POST",
        headers: { "Idempotency-Key": `${start.id}:${end.id}` },
        body: form,
      });
      const j = await res.json();
      if (!j.ok) {
        update(start.id, { status: "ready", message: j.error });
        update(end.id, { status: "ready", message: j.error });
        return false;
      }
      update(start.id, { status: "filed" });
      update(end.id, { status: "filed" });
      setTimeout(() => {
        remove(start.id);
        remove(end.id);
      }, 1200);
      return true;
    } catch {
      update(start.id, { status: "ready", message: "Network error." });
      update(end.id, { status: "ready", message: "Network error." });
      return false;
    }
  }

  // Pair the two odometer photos by reading, never by which screen they
  // show: the lower number is always the start of the drive.
  const odometerReady = cards.filter(
    (c) => c.type === "odometer" && (c.status === "ready" || c.status === "filing") && c.odo && !Number.isNaN(Number(c.odo)),
  );
  const startCard = odometerReady.length >= 2 ? odometerReady.reduce((a, b) => (Number(a.odo) <= Number(b.odo) ? a : b)) : null;
  const endCard = odometerReady.length >= 2 ? odometerReady.reduce((a, b) => (Number(a.odo) >= Number(b.odo) ? a : b)) : null;

  const receiptsReady = cards.filter((c) => c.type === "receipt" && c.status === "ready" && c.amount);
  const tripReady = !!(startCard && endCard && startCard.status === "ready" && endCard.status === "ready");
  const canFileAll = tripReady || receiptsReady.length > 0;

  async function fileAll() {
    setFilingAll(true);
    setBatchMessage(null);
    let filed = 0;
    let skipped = 0;
    if (tripReady && startCard && endCard) {
      const ok = await fileTripPair(startCard, endCard, tripPurpose || "Client visits");
      if (ok) filed += 1; else skipped += 1;
    }
    for (const c of receiptsReady) {
      const ok = await fileReceipt(c);
      if (ok) filed += 1; else skipped += 1;
    }
    setFilingAll(false);
    setBatchMessage(
      skipped
        ? { kind: "warn", text: `Filed ${filed}, ${skipped} needs a look.` }
        : { kind: "ok", text: `Filed ${filed} for ${batchDate}.` },
    );
  }

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.14em] text-[#8A928C]">
          <Ico name="camera" size={13} />
          Mileage and receipts
        </div>
        <div className="flex items-center gap-1.5">
          <input
            type="date"
            value={batchDate}
            onChange={(e) => setManualDate(e.target.value || todayPT())}
            className={`${inputCls} w-[152px]`}
            title="Filing date"
          />
          {dateOverridden && (
            <button type="button" onClick={() => setManualDate(null)} className={ghostBtn} title="Auto date">
              auto
            </button>
          )}
        </div>
      </div>

      <div
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          onFiles(e.dataTransfer.files);
        }}
        className={`flex min-h-[44px] cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border-2 border-dashed px-4 py-8 text-center transition-colors ${
          dragOver ? "border-[#14201B] bg-[#F1F0E8]" : "border-[#D9D5C7] bg-[#FAF9F5] hover:border-[#B9C4BC]"
        }`}
      >
        <Ico name="camera" size={22} />
        <div className="text-[14px] font-medium text-[#14201B]">Drop photos here</div>
        <div className="text-[12px] text-[#8A928C]">Tap to choose</div>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            onFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {startCard && endCard && (
        <div className="mt-3">
          <TripPairCard
            start={startCard}
            end={endCard}
            purpose={tripPurpose}
            onPurposeChange={setTripPurpose}
            onFile={() => fileTripPair(startCard, endCard, tripPurpose || "Client visits")}
            onEdit={update}
            onRemove={remove}
          />
        </div>
      )}

      {cards.length > 0 && (
        <div className="mt-3 flex flex-col gap-3">
          {cards.map((c) => {
            const inPair = (c.id === startCard?.id || c.id === endCard?.id) && startCard && endCard;
            if (inPair) return null;
            return <PhotoCardView key={c.id} card={c} onEdit={update} onRemove={remove} onFileReceipt={fileReceipt} />;
          })}
        </div>
      )}

      {cards.length > 0 && (
        <div className="mt-4 flex items-center justify-between gap-3 border-t border-[#E2DFD5] pt-3">
          {batchMessage ? (
            <p className={`text-[12.5px] leading-snug ${batchMessage.kind === "warn" ? "text-[#8A6D2F]" : "text-[#2C6A46]"}`}>{batchMessage.text}</p>
          ) : (
            <p className="text-[11.5px] leading-snug text-[#8A928C]">Filing to {batchDate}.</p>
          )}
          <button type="button" disabled={!canFileAll || filingAll} onClick={fileAll} className={`${primaryBtn} shrink-0`}>
            {filingAll ? "Filing..." : "File all"}
          </button>
        </div>
      )}
    </Card>
  );
}

function statusPill(status: PhotoCard["status"]) {
  const map: Record<PhotoCard["status"], { text: string; cls: string }> = {
    classifying: { text: "Sorting...", cls: "text-[#8A928C]" },
    ready: { text: "Ready to review", cls: "text-[#5B6560]" },
    paired: { text: "Paired", cls: "text-[#5B6560]" },
    filing: { text: "Filing...", cls: "text-[#8A6D2F]" },
    filed: { text: "Filed", cls: "text-[#2C6A46]" },
    error: { text: "Couldn't sort", cls: "text-[#8A2E2E]" },
  };
  return map[status];
}

function PhotoCardView({
  card, onEdit, onRemove, onFileReceipt,
}: {
  card: PhotoCard;
  onEdit: (id: string, patch: Partial<PhotoCard>) => void;
  onRemove: (id: string) => void;
  onFileReceipt: (card: PhotoCard) => void;
}) {
  const pill = statusPill(card.status);
  const filed = card.status === "filed";
  const busy = card.status === "filing" || card.status === "classifying";

  return (
    <div className="flex gap-3 rounded-md border border-[#E2DFD5] bg-[#FAF9F5] p-3">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={card.previewUrl} alt="" className="h-20 w-20 shrink-0 rounded object-cover" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <select
              value={card.type}
              disabled={filed || busy}
              onChange={(e) => onEdit(card.id, { type: e.target.value as PhotoType })}
              className="rounded border border-[#E2DFD5] bg-white px-1.5 py-1 text-[12px] font-medium text-[#14201B] disabled:opacity-60"
            >
              <option value="receipt">Receipt</option>
              <option value="odometer">Odometer</option>
              <option value="statement">Statement</option>
              <option value="unsure">Not sure</option>
            </select>
            {!filed && <span className={`text-[11.5px] ${pill.cls}`}>{pill.text}</span>}
          </div>
          {!filed && (
            <button type="button" onClick={() => onRemove(card.id)} className="p-1 text-[#8A928C] hover:text-[#8A2E2E]">
              <Ico name="close" size={13} />
            </button>
          )}
        </div>

        {card.message && <p className="mt-1 text-[11.5px] text-[#8A6D2F]">{card.message}</p>}

        {card.type === "receipt" && (filed ? (
          <div className="mt-2">
            <SuccessNote
              title="Filed"
              detail={`${card.merchant || "Receipt"}${card.amount ? `, $${card.amount}` : ""}${card.purpose ? `, ${card.purpose}` : ""}`}
            />
          </div>
        ) : (
          <div className="mt-2 flex flex-col gap-2">
            <div className="grid grid-cols-2 gap-2">
              <input placeholder="Merchant" value={card.merchant} onChange={(e) => onEdit(card.id, { merchant: e.target.value })} className={inputCls} />
              <input placeholder="Amount" value={card.amount} onChange={(e) => onEdit(card.id, { amount: e.target.value })} className={inputCls} />
            </div>
            <input placeholder="Purpose" value={card.purpose} onChange={(e) => onEdit(card.id, { purpose: e.target.value })} className={inputCls} />
            <div className="flex items-center justify-between gap-2">
              <label className="flex items-center gap-1.5 text-[12.5px] text-[#5B6560]">
                <input
                  type="checkbox"
                  checked={card.companyCard}
                  onChange={(e) => onEdit(card.id, { companyCard: e.target.checked })}
                />
                Company card
              </label>
              <button
                type="button"
                disabled={busy || !card.amount}
                onClick={() => onFileReceipt(card)}
                className={primaryBtn}
              >
                File it
              </button>
            </div>
          </div>
        ))}

        {card.type === "odometer" && (
          <div className="mt-2">
            <input
              placeholder="Odometer reading"
              value={card.odo}
              disabled={filed}
              onChange={(e) => onEdit(card.id, { odo: e.target.value })}
              className={inputCls}
            />
          </div>
        )}

        {card.type === "statement" && (
          <p className="mt-2 text-[11.5px] leading-snug text-[#8A928C]">Use the CLI for a statement.</p>
        )}

        {card.type === "unsure" && (
          <p className="mt-2 text-[11.5px] leading-snug text-[#8A928C]">Pick a type above.</p>
        )}
      </div>
    </div>
  );
}

function TripPairCard({
  start, end, purpose, onPurposeChange, onFile, onEdit, onRemove,
}: {
  start: PhotoCard;
  end: PhotoCard;
  purpose: string;
  onPurposeChange: (v: string) => void;
  onFile: () => void;
  onEdit: (id: string, patch: Partial<PhotoCard>) => void;
  onRemove: (id: string) => void;
}) {
  const filed = start.status === "filed" && end.status === "filed";
  const busy = start.status === "filing" || end.status === "filing";

  return (
    <div className="mb-3 rounded-md border border-[#B9C4BC] bg-white p-3">
      <div className="mb-2 flex items-center gap-2 text-[11px] uppercase tracking-[0.14em] text-[#8A928C]">
        <Ico name="gauge" size={13} />
        Trip, start to end
      </div>
      <div className="flex gap-3">
        {[{ c: start, label: "Start" }, { c: end, label: "End" }].map(({ c, label }) => (
          <div key={c.id} className="flex flex-1 items-center gap-2 rounded border border-[#E2DFD5] bg-[#FAF9F5] p-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={c.previewUrl} alt="" className="h-12 w-12 shrink-0 rounded object-cover" />
            <div className="min-w-0 flex-1">
              <div className="text-[11px] uppercase tracking-[0.08em] text-[#8A928C]">{label}</div>
              <input value={c.odo} disabled={filed} onChange={(e) => onEdit(c.id, { odo: e.target.value })} className={`${inputCls} mt-0.5`} placeholder="Odometer" />
            </div>
            {!filed && (
              <button type="button" onClick={() => onRemove(c.id)} className="p-1 text-[#8A928C] hover:text-[#8A2E2E]">
                <Ico name="close" size={12} />
              </button>
            )}
          </div>
        ))}
      </div>
      {filed ? (
        <div className="mt-2">
          <SuccessNote title="Trip filed" detail={`${start.odo} to ${end.odo}${purpose ? `, ${purpose}` : ""}`} />
        </div>
      ) : (
        <div className="mt-2 flex items-center gap-2">
          <input
            value={purpose}
            onChange={(e) => onPurposeChange(e.target.value)}
            placeholder="Purpose"
            className={`${inputCls} flex-1`}
          />
          <button
            type="button"
            disabled={busy || !start.odo || !end.odo || !purpose}
            onClick={onFile}
            className={`${primaryBtn} shrink-0`}
          >
            {busy ? "Filing..." : "File trip"}
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// hours
// ---------------------------------------------------------------------------

/* 0 to 3h. Past three hours it is not a break, it is a split shift. */
const BREAK_CHOICES = [0, 30, 60, 90, 120, 150, 180];

/** 0 -> "None", 30 -> "30 min", 90 -> "1h 30m". */
function breakLabel(m: number): string {
  if (m === 0) return "None";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h}h ${rest}m` : `${h}h`;
}

/* Half-hour grid, matching the Break dropdown. A field day runs roughly
   5am-2pm to 2pm-2am, so the two fields get their own windows rather than
   one 00:00-23:30 list for both. */
function halfHourRange(startMin: number, endMin: number): string[] {
  const out: string[] = [];
  for (let m = startMin; m <= endMin; m += 30) {
    const hh = Math.floor((m % 1440) / 60);
    const mm = m % 60 === 0 ? "00" : "30";
    out.push(`${String(hh).padStart(2, "0")}:${mm}`);
  }
  return out;
}
const CLOCK_IN_CHOICES: string[] = halfHourRange(5 * 60, 14 * 60);
// Wraps past midnight: 14:00 through 23:30, then 00:00 through 02:00.
const CLOCK_OUT_CHOICES: string[] = halfHourRange(14 * 60, 26 * 60);

/** "14:30" -> "2:30 PM". */
function timeLabel(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const period = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${period}`;
}

function HoursCard() {
  const [date, setDate] = useState(todayPT());
  const [clockIn, setClockIn] = useState("");
  const [clockOut, setClockOut] = useState("");
  const [breakMin, setBreakMin] = useState("0");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "warn" | "error"; text: string } | null>(null);
  // One key per pending entry: stable across a retry of the same submission,
  // regenerated once that entry has actually filed.
  const [pendingKey, setPendingKey] = useState(() => newId());

  /* Half-hour grid: a field day is remembered as "started around nine,
     knocked off around five", never to the minute. Rounds to nearest, not
     down, so a "now" tap never shades hours worked downward. */
  function markNow(which: "in" | "out") {
    const now = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "America/Los_Angeles" });
    const [h, m] = now.split(":").map(Number);
    let mins = Math.round((h * 60 + m) / 30) * 30;
    mins = Math.min(mins, 23 * 60 + 30);
    if (which === "in") {
      mins = Math.min(Math.max(mins, 5 * 60), 14 * 60);
      setClockIn(`${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`);
    } else {
      if (mins >= 2 * 60 && mins < 14 * 60) mins = 14 * 60;
      setClockOut(`${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`);
    }
  }

  async function submit() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/expenses/hours", {
        method: "POST",
        headers: { "content-type": "application/json", "Idempotency-Key": pendingKey },
        body: JSON.stringify({ date, clock_in: clockIn, clock_out: clockOut, break_min: Number(breakMin || 0), notes }),
      });
      const j = await res.json();
      if (!j.ok) {
        setMessage({ kind: "error", text: j.error });
        return;
      }
      if (j.result.status === "duplicate") {
        setMessage({ kind: "warn", text: j.result.why });
        return;
      }
      const flags: string[] = [];
      if (j.result.boundaryWeek) flags.push("this week crosses a pay period boundary");
      if (j.result.sevenDayWeek) flags.push("7th day worked this week");
      setMessage({
        kind: flags.length ? "warn" : "ok",
        text: `Filed ${j.result.hoursWorked}h for ${date}.${flags.length ? " " + flags.join("; ") + "." : ""}`,
      });
      setClockIn("");
      setClockOut("");
      setBreakMin("0");
      setNotes("");
      setPendingKey(newId());
      if (!flags.length) setTimeout(() => setMessage((m) => (m?.text.startsWith("Filed") ? null : m)), 1200);
    } catch {
      setMessage({ kind: "error", text: "Network error." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <div className="mb-3 flex items-center gap-2 text-[11px] uppercase tracking-[0.14em] text-[#8A928C]">
        <Ico name="clock" size={13} />
        Hours
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div>
          <label className={labelCls}>Date</label>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            onBlur={(e) => { if (!e.target.value) setDate(todayPT()); }}
            className={inputCls}
          />
        </div>
        <div>
          <label className={labelCls}>Clock in</label>
          <div className="flex gap-1.5">
            <select value={clockIn} onChange={(e) => setClockIn(e.target.value)} className={inputCls}>
              <option value="" disabled>
                Select
              </option>
              {CLOCK_IN_CHOICES.map((t) => (
                <option key={t} value={t}>
                  {timeLabel(t)}
                </option>
              ))}
            </select>
            <button type="button" onClick={() => markNow("in")} className={`${ghostBtn} shrink-0 px-2`} title="Now">
              now
            </button>
          </div>
        </div>
        <div>
          <label className={labelCls}>Clock out</label>
          <div className="flex gap-1.5">
            <select value={clockOut} onChange={(e) => setClockOut(e.target.value)} className={inputCls}>
              <option value="" disabled>
                Select
              </option>
              {CLOCK_OUT_CHOICES.map((t) => (
                <option key={t} value={t}>
                  {timeLabel(t)}
                </option>
              ))}
            </select>
            <button type="button" onClick={() => markNow("out")} className={`${ghostBtn} shrink-0 px-2`} title="Now">
              now
            </button>
          </div>
        </div>
        <div>
          <label className={labelCls}>Break (min)</label>
          <select value={breakMin} onChange={(e) => setBreakMin(e.target.value)} className={inputCls}>
            {BREAK_CHOICES.map((m) => (
              <option key={m} value={String(m)}>
                {breakLabel(m)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="mt-3">
        <label className={labelCls}>Notes</label>
        <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Field day, SoCal loop" className={inputCls} />
      </div>
      <div className="mt-3 flex items-center justify-between gap-3">
        {message && message.kind !== "ok" ? (
          <p className={`text-[12.5px] leading-snug ${message.kind === "error" ? "text-[#8A2E2E]" : "text-[#8A6D2F]"}`}>
            {message.text}
          </p>
        ) : (
          <span />
        )}
        <button type="button" onClick={submit} disabled={busy || !clockIn || !clockOut} className={`${primaryBtn} shrink-0`}>
          {busy ? "Filing..." : "File hours"}
        </button>
      </div>
      {message?.kind === "ok" && (
        <div className="mt-3">
          <SuccessNote title="Hours filed" detail={message.text} />
        </div>
      )}
    </Card>
  );
}
