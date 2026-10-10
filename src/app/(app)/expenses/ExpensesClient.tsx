"use client";

/**
 * Expenses, from the browser. Two cards: a photo drop zone that auto-sorts
 * what it's handed (odometer vs receipt vs bank-statement screenshot), and a
 * link to the pay period's live sheet. Every filing writes to the same Drive/Sheets tree the CLI's
 * `expensos` skill does, see lib/shared/expenses.ts.
 *
 * Ported from the NutriBiotic OS
 * (portfolio/src/app/nutribiotic/expenses/ExpensesClient.tsx). Business
 * logic (classification handling, date detection, pairing, filing) is
 * unchanged; each write now carries an Idempotency-Key so a retry never
 * files twice (PORTING.md), and goes through the write queue (writeq.ts):
 * with no signal it is kept on the phone and sent when signal returns.
 *
 * AUTO-SORT IS A SUGGESTION, NEVER A SILENT SUBMIT. Every field the
 * classifier proposes lands in an editable field. Filing is always a
 * deliberate tap.
 */

import { apiFetch, getJson, peekJson } from "@/lib/core/api";
import { UnsentList } from "@/lib/core/unsent";
import { submitWrite } from "@/lib/core/writeq";
import { useEffect, useRef, useState } from "react";
import { Card, Ico, SuccessNote, displayFace, eyebrowCls, ghostBtn, inputCls, primaryBtn } from "../../../lib/core/ui";

type Summary = { period: string; label: string; sheetLink: string } | null;
type SummaryPayload = { ok: boolean; period: string; label: string; sheetLink: string };

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

export function ExpensesClient() {
  const [summary, setSummary] = useState<Summary>(() => {
    const j = peekJson<SummaryPayload>("/api/expenses/summary");
    return j?.ok ? { period: j.period, label: j.label, sheetLink: j.sheetLink } : null;
  });
  const [summaryError, setSummaryError] = useState<string | null>(null);

  useEffect(() => {
    getJson<SummaryPayload>("/api/expenses/summary")
      .then((j) => (j.ok ? setSummary({ period: j.period, label: j.label, sheetLink: j.sheetLink }) : setSummaryError("unavailable")))
      .catch(() => setSummaryError("unavailable"));
  }, []);

  return (
    <div className="flex flex-col gap-5">
      <ReviewCard summary={summary} error={summaryError} />
      <PhotosCard />
    </div>
  );
}

function ReviewCard({ summary, error }: { summary: Summary; error: string | null }) {
  return (
    <Card className="flex items-center justify-between gap-4">
      <div>
        <div className={eyebrowCls}>Current pay period</div>
        <div className={`${displayFace} mt-1 text-[17px] font-semibold tracking-tight`}>
          {summary?.label ?? (error ? "Not available right now" : "Loading...")}
        </div>
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
      const res = await apiFetch("/api/expenses/classify", { method: "POST", body: form });
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
      // No signal: the card is still fileable by hand, and filing queues it.
      update(card.id, { status: "ready", message: "Could not classify. Pick a type by hand." });
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
    try {
      const r = await submitWrite({
        screen: "expenses/photos",
        label: [card.merchant || "Receipt", card.amount ? `$${card.amount}` : "", batchDate].filter(Boolean).join(", "),
        path: "/api/expenses/receipt",
        key: card.id,
        fields: {
          date: batchDate,
          merchant: card.merchant,
          purpose: card.purpose,
          amount: card.amount,
          companyCard: String(card.companyCard),
        },
        files: [{ field: "photo", file: card.file }],
      });
      if (r.status === "failed") {
        update(card.id, { status: "ready", message: r.error });
        return false;
      }
      // Landed, or kept on the phone to send with signal (shown below).
      update(card.id, { status: "filed" });
      setTimeout(() => remove(card.id), 1200);
      return true;
    } catch {
      update(card.id, { status: "ready", message: "Could not save that on the phone." });
      return false;
    }
  }

  async function fileTripPair(start: PhotoCard, end: PhotoCard, purpose: string): Promise<boolean> {
    update(start.id, { status: "filing" });
    update(end.id, { status: "filing" });
    try {
      const r = await submitWrite({
        screen: "expenses/photos",
        label: `Trip ${start.odo} to ${end.odo}, ${batchDate}`,
        path: "/api/expenses/trip",
        key: `${start.id}:${end.id}`,
        fields: {
          date: batchDate,
          end_date: batchDate,
          start_odo: start.odo,
          end_odo: end.odo,
          purpose,
        },
        files: [
          { field: "start_photo", file: start.file },
          { field: "end_photo", file: end.file },
        ],
      });
      if (r.status === "failed") {
        update(start.id, { status: "ready", message: r.error });
        update(end.id, { status: "ready", message: r.error });
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
      update(start.id, { status: "ready", message: "Could not save that on the phone." });
      update(end.id, { status: "ready", message: "Could not save that on the phone." });
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
        <div className={`flex items-center gap-2 ${eyebrowCls}`}>
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
      <UnsentList screen="expenses/photos" />
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
      <div className={`mb-2 flex items-center gap-2 ${eyebrowCls}`}>
        <Ico name="gauge" size={13} />
        Trip, start to end
      </div>
      <div className="flex gap-3">
        {[{ c: start, label: "Start" }, { c: end, label: "End" }].map(({ c, label }) => (
          <div key={c.id} className="flex flex-1 items-center gap-2 rounded border border-[#E2DFD5] bg-[#FAF9F5] p-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={c.previewUrl} alt="" className="h-12 w-12 shrink-0 rounded object-cover" />
            <div className="min-w-0 flex-1">
              <div className="text-[11px] text-[#8A928C]">{label}</div>
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
