"use client";

/**
 * The three door counts, typed on the phone's big number pad: supplement
 * shelves, the staff selling them, the stores one owner runs. One row used by
 * Visit (sent with the note) and the client view (saved on the account).
 * Values are digit strings; a blank slot is absent, never zero.
 */

export const COUNT_SLOTS = [
  { field: "shelf_units", label: "Shelves", aria: "Supplement shelves" },
  { field: "employee_count", label: "Staff", aria: "People selling supplements" },
  { field: "stores_per_decision_maker", label: "Stores", aria: "Stores with this owner" },
] as const;

export type CountField = (typeof COUNT_SLOTS)[number]["field"];
export type CountValues = Record<CountField, string>;

export const BLANK_COUNTS: CountValues = { shelf_units: "", employee_count: "", stores_per_decision_maker: "" };

/** An account's stored counts as slot strings. */
export function countsOf(a: Partial<Record<CountField, number | null>> | null | undefined): CountValues {
  const s = (v: number | null | undefined) => (v == null ? "" : String(v));
  return { shelf_units: s(a?.shelf_units), employee_count: s(a?.employee_count), stores_per_decision_maker: s(a?.stores_per_decision_maker) };
}

export function CountSlots({
  values,
  onChange,
  onCommit,
  disabled,
}: {
  values: CountValues;
  onChange: (field: CountField, value: string) => void;
  /** Blur or Return on a slot. */
  onCommit?: (field: CountField) => void;
  disabled?: boolean;
}) {
  return (
    <div className="grid grid-cols-3 gap-2">
      {COUNT_SLOTS.map((s) => (
        <label key={s.field} className="flex min-w-0 flex-col gap-1">
          <span className="text-[11px] uppercase tracking-[0.14em] text-[#8A928C]">{s.label}</span>
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            enterKeyHint="done"
            autoComplete="off"
            aria-label={s.aria}
            disabled={disabled}
            value={values[s.field]}
            onChange={(e) => onChange(s.field, e.target.value.replace(/[^0-9]/g, "").slice(0, 4))}
            onBlur={() => onCommit?.(s.field)}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            className={`h-11 w-full min-w-0 rounded-md border bg-[#FAF9F5] px-3 text-center text-[17px] font-medium text-[#14201B] tabular-nums transition-colors focus:border-[#14201B]/60 focus:outline-none ${
              values[s.field] === "" ? "border-dashed border-[#D8D4C6]" : "border-[#E2DFD5]"
            }`}
          />
        </label>
      ))}
    </div>
  );
}
