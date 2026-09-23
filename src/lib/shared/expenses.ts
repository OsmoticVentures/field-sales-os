/**
 * Expense and hours filing, ported unchanged from the NutriBiotic OS
 * (portfolio/src/app/nutribiotic/lib/expenses.ts).
 *
 * SHARED, NOT EXPENSES-ONLY. This lives under lib/shared because the Route
 * Planner port (a later milestone) calls fileTripFromLinks/uploadMileagePhoto
 * from its own widget-mileage flow, exactly like the source app. Don't move
 * it back under a feature-owned path.
 *
 * SAME TREE AS THE CLI. This is a third door onto the same Drive/Sheets tree
 * the Mac-side `expense_log.py` bridge files into, and shares its layout
 * constants, period math, and overtime tiers, so a period filed half from
 * the CLI and half from here reads as one claim. If the layout changes on
 * one side, move the other with it, there is no automated check for that yet.
 *
 * NO SHARED LEDGER. `expense_log.py` dedupes photo re-runs against a local
 * ledger file that only exists on Juan's Mac. This module has no such file
 * and no database of its own for that. Bulk end-of-day filing from a camera
 * roll should still go through the CLI's `expensos` skill, which has the
 * ledger; this UI's own duplicate protection is the idempotency guard each
 * route handler applies (see lib/core/idempotency.ts), not a content hash.
 *
 * MILEAGE RATE is duplicated from the Mac bridge's config rather than read
 * from it (this app cannot see that file). If Juan states a new rate, both
 * places need to change together.
 */
import "server-only";
import {
  asOwnerLink,
  ensureFolder,
  ensureSpreadsheet,
  hyperlink,
  nextFreeRow,
  readColumn,
  tabId,
  batchUpdate,
  uploadFile,
  writeRange,
} from "./gdrive";

const ROOT_FOLDER = "NutriBiotic Field Expenses";
const LOG_TAB = "Log";
const HOURS_TAB = "Hours";
// Cost/Reimbursement split: Cost is what was actually spent, Reimbursement
// is what NutriBiotic owes back. They differ only on a company-card charge
// (Reimbursement 0).
const EXPENSE_HEADER = ["Date", "Merchant", "Purpose", "Cost", "Reimbursement", "Link"];
const MILES_HEADER = ["Start Odo", "Link", "End Odo", "Link", "Distance", "Mileage Comp"];
const HOURS_HEADER = ["Date", "Day", "Clock In", "Clock Out", "Break (hours)", "Hours Worked", "Regular", "OT 1.5x", "OT 2x", "Notes"];
const TOTALS_ROW = 2;
const FIRST_DATA_ROW = 3;
const LAST_ROW = 2000;
// Hours-tab-only bound, tighter than the Log tab's LAST_ROW: one row per
// day, and a semi-monthly period never exceeds 16 days.
const HOURS_LAST_ROW = 20;
const LIGHT_GREEN = { red: 0.91, green: 0.961, blue: 0.914 };

// Paired with the Mac bridge's own mileage-rate config. Change both together.
const MILEAGE_RATE = 0.76;

export type PeriodBounds = { start: Date; end: Date };

// Pay periods run Monday through the following Sunday, a fixed 14-day
// cadence. This epoch is a Monday and a period start; every other boundary
// is this date shifted by a whole multiple of 14 days, forever in both
// directions.
const PERIOD_EPOCH_MS = Date.UTC(2026, 7, 31);
const MS_PER_DAY = 86_400_000;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function ymd(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** All date math here is calendar-day arithmetic in Pacific local time, never
 *  UTC-shifted, so a photo filed at 11pm doesn't land on tomorrow's period.
 *  Callers pass plain YYYY-MM-DD strings for exactly this reason. */
function parseDate(dateStr: string): Date {
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`not a date: ${dateStr}`);
  return d;
}

/** A date before PERIOD_EPOCH still gets the calendar 1st-15th/16th-end split
 *  the Monday cadence replaced, never the Monday math projected backward. */
export function periodBounds(dateStr: string): PeriodBounds {
  const d = parseDate(dateStr);
  if (d.getTime() < PERIOD_EPOCH_MS) {
    const day = d.getUTCDate();
    if (day <= 15) {
      const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
      const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 15);
      return { start: new Date(start), end: new Date(end) };
    }
    const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 16);
    const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0); // last day of month
    return { start: new Date(start), end: new Date(end) };
  }
  const diffDays = Math.floor((d.getTime() - PERIOD_EPOCH_MS) / MS_PER_DAY);
  const periodIndex = Math.floor(diffDays / 14);
  const startMs = PERIOD_EPOCH_MS + periodIndex * 14 * MS_PER_DAY;
  return { start: new Date(startMs), end: new Date(startMs + 13 * MS_PER_DAY) };
}

/** The "2026-09a" (first half) / "2026-09b" (second half) label a 14-day
 *  period is filed under: whichever month owns the period's 7th day. */
function periodLabelParts(bounds: PeriodBounds): { year: number; month: number; half: "a" | "b" } {
  const mid = new Date(bounds.start.getTime() + 6 * MS_PER_DAY);
  return {
    year: mid.getUTCFullYear(),
    month: mid.getUTCMonth() + 1,
    half: mid.getUTCDate() <= 15 ? "a" : "b",
  };
}

export function periodKey(dateStr: string): string {
  const { year, month, half } = periodLabelParts(periodBounds(dateStr));
  return `pp_${year}_${pad2(month)}${half}`;
}

export function periodLabel(dateStr: string): string {
  const { start, end } = periodBounds(dateStr);
  const startMonth = start.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
  const endMonth = end.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
  if (startMonth === endMonth && start.getUTCFullYear() === end.getUTCFullYear()) {
    return `period ${startMonth} ${start.getUTCDate()}-${end.getUTCDate()}, ${end.getUTCFullYear()}`;
  }
  return `period ${startMonth} ${start.getUTCDate()} - ${endMonth} ${end.getUTCDate()}, ${end.getUTCFullYear()}`;
}

export function sheetName(dateStr: string): string {
  const { year, month, half } = periodLabelParts(periodBounds(dateStr));
  return `expense-report-${year}-${pad2(month)}${half}`;
}

/** The Sunday (UTC-date-math) that starts the fixed 7-day workweek
 *  California overtime is computed against, independent of the pay period. */
export function workweekStart(dateStr: string): string {
  const d = parseDate(dateStr);
  const dow = d.getUTCDay(); // 0 = Sunday already
  const sunday = new Date(d);
  sunday.setUTCDate(d.getUTCDate() - dow);
  return ymd(sunday);
}

function addDays(dateStr: string, n: number): string {
  const d = parseDate(dateStr);
  d.setUTCDate(d.getUTCDate() + n);
  return ymd(d);
}

type Tree = { yearFolderId: string; periodFolderId: string; sheetId: string; sheetLink: string };

async function ensureTree(dateStr: string): Promise<Tree> {
  const d = parseDate(dateStr);
  const yearFolder = await ensureFolder(`${ROOT_FOLDER} ${d.getUTCFullYear()}`, null);
  const periodFolder = await ensureFolder(periodLabel(dateStr), yearFolder.id);
  const sheet = await ensureSpreadsheet(sheetName(dateStr), periodFolder.id, { [LOG_TAB]: [], [HOURS_TAB]: [] });

  const logHeaderCol = await readColumn(sheet.id, `${LOG_TAB}!A1:A1`);
  if (logHeaderCol.length === 0) {
    await writeRange(sheet.id, `${LOG_TAB}!A1:F1`, [EXPENSE_HEADER]);
    await writeRange(sheet.id, `${LOG_TAB}!G1:N1`, [["DAY", ...MILES_HEADER, "Total Field Comp"]]);
    // Total Field Comp sums Reimbursement (E), not Cost (D): the claim is
    // what's owed back, a company-card charge sits in Cost without
    // inflating it.
    await writeRange(sheet.id, `${LOG_TAB}!A${TOTALS_ROW}:N${TOTALS_ROW}`, [[
      "TOTAL", "", "",
      `=SUM(D${FIRST_DATA_ROW}:D${LAST_ROW})`,
      `=SUM(E${FIRST_DATA_ROW}:E${LAST_ROW})`, "", "", "", "", "", "",
      `=SUM(L${FIRST_DATA_ROW}:L${LAST_ROW})`,
      `=ROUND(L${TOTALS_ROW}*${MILEAGE_RATE},2)`,
      `=E${TOTALS_ROW}+M${TOTALS_ROW}`,
    ]]);
    await styleLogSheet(sheet.id);
  }

  const hoursHeaderCol = await readColumn(sheet.id, `${HOURS_TAB}!A1:A1`);
  if (hoursHeaderCol.length === 0) {
    await writeRange(sheet.id, `${HOURS_TAB}!A1:J1`, [HOURS_HEADER]);
    await writeRange(sheet.id, `${HOURS_TAB}!A${TOTALS_ROW}:J${TOTALS_ROW}`, [[
      "TOTAL", "", "", "",
      `=SUM(E${FIRST_DATA_ROW}:E${HOURS_LAST_ROW})`,
      `=SUM(F${FIRST_DATA_ROW}:F${HOURS_LAST_ROW})`,
      `=MIN(SUM(G${FIRST_DATA_ROW}:G${HOURS_LAST_ROW}),40)`,
      `=SUM(H${FIRST_DATA_ROW}:H${HOURS_LAST_ROW})+MAX(0,SUM(G${FIRST_DATA_ROW}:G${HOURS_LAST_ROW})-40)`,
      `=SUM(I${FIRST_DATA_ROW}:I${HOURS_LAST_ROW})`, "",
    ]]);
    await styleHoursSheet(sheet.id);
  }

  return { yearFolderId: yearFolder.id, periodFolderId: periodFolder.id, sheetId: sheet.id, sheetLink: sheet.webViewLink };
}

async function styleLogSheet(sheetId: string): Promise<void> {
  const gid = await tabId(sheetId, LOG_TAB);
  const money = { type: "CURRENCY", pattern: '"$"#,##0.00' };
  await batchUpdate(sheetId, [
    { repeatCell: { range: { sheetId: gid, startRowIndex: 0, endRowIndex: TOTALS_ROW, startColumnIndex: 0, endColumnIndex: 14 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: "userEnteredFormat.textFormat.bold" } },
    { updateSheetProperties: { properties: { sheetId: gid, gridProperties: { frozenRowCount: TOTALS_ROW } }, fields: "gridProperties.frozenRowCount" } },
    { repeatCell: { range: { sheetId: gid, startRowIndex: TOTALS_ROW - 1, endRowIndex: LAST_ROW, startColumnIndex: 3, endColumnIndex: 5 }, cell: { userEnteredFormat: { numberFormat: money } }, fields: "userEnteredFormat.numberFormat" } },
    { repeatCell: { range: { sheetId: gid, startRowIndex: TOTALS_ROW - 1, endRowIndex: LAST_ROW, startColumnIndex: 12, endColumnIndex: 14 }, cell: { userEnteredFormat: { numberFormat: money } }, fields: "userEnteredFormat.numberFormat" } },
    { repeatCell: { range: { sheetId: gid, startRowIndex: TOTALS_ROW - 1, endRowIndex: LAST_ROW, startColumnIndex: 11, endColumnIndex: 12 }, cell: { userEnteredFormat: { numberFormat: { type: "NUMBER", pattern: "0.0" } } }, fields: "userEnteredFormat.numberFormat" } },
    { addConditionalFormatRule: { index: 0, rule: { ranges: [{ sheetId: gid, startRowIndex: FIRST_DATA_ROW - 1, endRowIndex: LAST_ROW, startColumnIndex: 0, endColumnIndex: 14 }], booleanRule: { condition: { type: "CUSTOM_FORMULA", values: [{ userEnteredValue: "=ISEVEN(ROW())" }] }, format: { backgroundColor: LIGHT_GREEN } } } } },
  ]);
}

async function styleHoursSheet(sheetId: string): Promise<void> {
  const gid = await tabId(sheetId, HOURS_TAB);
  const hrs = { type: "NUMBER", pattern: "0.00" };
  await batchUpdate(sheetId, [
    { repeatCell: { range: { sheetId: gid, startRowIndex: 0, endRowIndex: TOTALS_ROW, startColumnIndex: 0, endColumnIndex: 10 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: "userEnteredFormat.textFormat.bold" } },
    { updateSheetProperties: { properties: { sheetId: gid, gridProperties: { frozenRowCount: TOTALS_ROW } }, fields: "gridProperties.frozenRowCount" } },
    { repeatCell: { range: { sheetId: gid, startRowIndex: TOTALS_ROW - 1, endRowIndex: HOURS_LAST_ROW, startColumnIndex: 4, endColumnIndex: 9 }, cell: { userEnteredFormat: { numberFormat: hrs } }, fields: "userEnteredFormat.numberFormat" } },
    { addConditionalFormatRule: { index: 0, rule: { ranges: [{ sheetId: gid, startRowIndex: FIRST_DATA_ROW - 1, endRowIndex: HOURS_LAST_ROW, startColumnIndex: 0, endColumnIndex: 10 }], booleanRule: { condition: { type: "CUSTOM_FORMULA", values: [{ userEnteredValue: "=ISEVEN(ROW())" }] }, format: { backgroundColor: LIGHT_GREEN } } } } },
  ]);
}

export async function periodSummary(dateStr: string): Promise<{ period: string; label: string; sheetLink: string }> {
  const tree = await ensureTree(dateStr);
  return { period: periodKey(dateStr), label: periodLabel(dateStr), sheetLink: asOwnerLink(tree.sheetLink) };
}

// ---------------------------------------------------------------------------
// hours
// ---------------------------------------------------------------------------

export type HoursInput = { date: string; clockIn: string; clockOut: string; breakMin: number; notes: string };
export type HoursResult = {
  status: "filed" | "duplicate";
  date?: string;
  hoursWorked?: number;
  sheetLink?: string;
  boundaryWeek?: boolean;
  sevenDayWeek?: boolean;
  why?: string;
};

function parseClock(dateStr: string, hhmm: string): Date {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) throw new Error(`${hhmm} is not HH:MM 24h.`);
  const d = parseDate(dateStr);
  d.setUTCHours(Number(m[1]), Number(m[2]), 0, 0);
  return d;
}

export async function fileHours(input: HoursInput): Promise<HoursResult> {
  const { date, clockIn, clockOut, breakMin, notes } = input;
  const tree = await ensureTree(date);

  const existingDates = await readColumn(tree.sheetId, `${HOURS_TAB}!A${FIRST_DATA_ROW}:A${HOURS_LAST_ROW}`);
  if (existingDates.includes(date)) {
    return { status: "duplicate", why: `${date} is already filed for this period. Amend it from the CLI (expensos) instead of re-filing.` };
  }

  const inAt = parseClock(date, clockIn);
  let outAt = parseClock(date, clockOut);
  // The web picker's clock-out window is 2pm-2am, so a clock out at/before
  // clock in always means the 2am wrap into the next calendar day, not a
  // bad reading.
  if (outAt.getTime() <= inAt.getTime()) {
    outAt = new Date(outAt.getTime() + 24 * 3_600_000);
  }
  const worked = Math.round(((outAt.getTime() - inAt.getTime()) / 3_600_000 - breakMin / 60) * 100) / 100;
  if (worked <= 0) {
    throw new Error(`The break (${breakMin} min) is not shorter than the shift. Nothing filed.`);
  }

  const day = parseDate(date).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
  const row = Math.max(await nextFreeRow(tree.sheetId, HOURS_TAB, "A"), FIRST_DATA_ROW);
  const breakHours = Math.round((breakMin / 60) * 100) / 100;
  await writeRange(tree.sheetId, `${HOURS_TAB}!A${row}:J${row}`, [[
    date, day, clockIn, clockOut, breakHours, worked,
    `=MIN(F${row},8)`, `=MAX(0,MIN(F${row},12)-8)`, `=MAX(0,F${row}-12)`, notes,
  ]]);

  const { start, end } = periodBounds(date);
  const wkStart = parseDate(workweekStart(date));
  const wkEnd = parseDate(addDays(workweekStart(date), 6));
  const boundaryWeek = wkStart.getTime() < start.getTime() || wkEnd.getTime() > end.getTime();

  const allDatesThisPeriod = [...existingDates, date];
  const wk = workweekStart(date);
  const sameWeekCount = allDatesThisPeriod.filter((d) => d && workweekStart(d) === wk).length;

  return {
    status: "filed", date, hoursWorked: worked, sheetLink: asOwnerLink(tree.sheetLink),
    boundaryWeek, sevenDayWeek: sameWeekCount >= 7,
  };
}

// ---------------------------------------------------------------------------
// receipts / trips
// ---------------------------------------------------------------------------

export type ReceiptInput = {
  date: string; merchant: string; purpose: string; amount: string;
  // Defaults to `amount` (fully reimbursable) when omitted. Pass "0" for a
  // company-card charge: real spend, nothing owed back.
  reimbursement?: string;
  photo: { bytes: ArrayBuffer; mimeType: string; filename: string };
};

export async function fileReceipt(input: ReceiptInput): Promise<{ sheetLink: string; photoLink: string }> {
  const tree = await ensureTree(input.date);
  const ext = extOf(input.photo.filename, input.photo.mimeType);
  const stamp = input.date.replace(/-/g, "");
  const uploaded = await uploadFile(input.photo.bytes, input.photo.mimeType, tree.periodFolderId, `${stamp}_receipt_${randomSuffix()}${ext}`);
  const photoLink = asOwnerLink(uploaded.webViewLink);
  const reimbursement = input.reimbursement ?? input.amount;

  const row = Math.max(await nextFreeRow(tree.sheetId, LOG_TAB, "A"), FIRST_DATA_ROW);
  await writeRange(tree.sheetId, `${LOG_TAB}!A${row}:F${row}`, [[
    input.date, input.merchant, input.purpose, input.amount, reimbursement, hyperlink(photoLink, "receipt"),
  ]]);

  return { sheetLink: asOwnerLink(tree.sheetLink), photoLink };
}

export type TripInput = {
  date: string; endDate?: string; purpose: string;
  startOdo: string; endOdo: string;
  startPhoto: { bytes: ArrayBuffer; mimeType: string; filename: string };
  endPhoto: { bytes: ArrayBuffer; mimeType: string; filename: string };
};

/**
 * Upload one odometer photo into its date's period folder, tagged start/end.
 * Split out from fileTrip for the Route Planner widget's camera-gated
 * mileage flow, which captures a start photo hours before the end one
 * exists. fileTrip below calls this too, unchanged externally.
 */
export async function uploadMileagePhoto(
  date: string,
  moment: "start" | "end",
  photo: { bytes: ArrayBuffer; mimeType: string; filename: string },
): Promise<{ driveFileId: string; photoLink: string }> {
  const tree = await ensureTree(date);
  const stamp = date.replace(/-/g, "");
  const up = await uploadFile(photo.bytes, photo.mimeType, tree.periodFolderId, `${stamp}_trip-${moment}_${randomSuffix()}${extOf(photo.filename, photo.mimeType)}`);
  return { driveFileId: up.id, photoLink: asOwnerLink(up.webViewLink) };
}

/**
 * The H:M sheet row, given two already-uploaded photo links rather than raw
 * bytes, the other half of fileTrip's split. Both entry points end at the
 * exact same row shape, so a trip filed from the widget and one filed from
 * /expenses read identically on the sheet.
 */
export async function fileTripFromLinks(input: {
  date: string; startOdo: string; endOdo: string; startLink: string; endLink: string;
}): Promise<{ sheetLink: string; miles: number }> {
  const startNum = Number(String(input.startOdo).replace(/,/g, ""));
  const endNum = Number(String(input.endOdo).replace(/,/g, ""));
  if (!Number.isFinite(startNum) || !Number.isFinite(endNum)) {
    throw new Error("Odometer readings must be plain digits, a decimal is fine. An unreadable photo is a blank, never a guess.");
  }
  if (endNum < startNum) {
    throw new Error(`The end odometer (${input.endOdo}) is lower than the start (${input.startOdo}). Check which photo is which.`);
  }

  const tree = await ensureTree(input.date);
  // H:M, not G:L: G is the gap/DAY column between the two tables. Mileage
  // Comp (M) stays blank per row, a totals-row-only figure.
  const row = Math.max(await nextFreeRow(tree.sheetId, LOG_TAB, "H"), FIRST_DATA_ROW);
  await writeRange(tree.sheetId, `${LOG_TAB}!H${row}:M${row}`, [[
    input.startOdo, hyperlink(input.startLink, "photo"),
    input.endOdo, hyperlink(input.endLink, "photo"),
    `=IF(OR(H${row}="",J${row}=""),"",J${row}-H${row})`,
    "",
  ]]);

  return { sheetLink: asOwnerLink(tree.sheetLink), miles: Math.round((endNum - startNum) * 10) / 10 };
}

export async function fileTrip(input: TripInput): Promise<{ sheetLink: string; miles: number }> {
  // Fail fast on a bad reading before spending two Drive uploads on a
  // request that's about to be rejected anyway.
  if (!Number.isFinite(Number(String(input.startOdo).replace(/,/g, "")))
    || !Number.isFinite(Number(String(input.endOdo).replace(/,/g, "")))) {
    throw new Error("Odometer readings must be plain digits, a decimal is fine. An unreadable photo is a blank, never a guess.");
  }
  const startUp = await uploadMileagePhoto(input.date, "start", input.startPhoto);
  const endUp = await uploadMileagePhoto(input.endDate ?? input.date, "end", input.endPhoto);
  return fileTripFromLinks({
    date: input.date, startOdo: input.startOdo, endOdo: input.endOdo,
    startLink: startUp.photoLink, endLink: endUp.photoLink,
  });
}

function extOf(filename: string, mimeType: string): string {
  const fromName = /\.[a-zA-Z0-9]+$/.exec(filename)?.[0];
  if (fromName) return fromName.toLowerCase();
  if (mimeType.includes("png")) return ".png";
  if (mimeType.includes("heic")) return ".heic";
  return ".jpg";
}

function randomSuffix(): string {
  return Math.random().toString(16).slice(2, 10);
}
