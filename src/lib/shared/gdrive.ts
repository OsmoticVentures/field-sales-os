/**
 * Google Drive + Sheets, server-side, via the SAME OAuth user token the
 * Mac-side `expense_log.py` bridge runs with, ported unchanged from the
 * NutriBiotic OS (portfolio/src/app/nutribiotic/lib/gdrive.ts). Not a
 * service account: Google refuses storage quota to one ("Leverage shared
 * drives... or use OAuth delegation instead"), and this Google account has
 * no Workspace seat for a shared drive either. OAuth delegation, reusing the
 * already-consented token, is the one path, and the narrower one: it only
 * reaches what that token's `drive.file` scope already covers.
 *
 * NO ID CACHE. This is a stateless serverless function, so every call
 * resolves folders/sheets by NAME (find-or-create).
 *
 * OWNER_EMAIL is baked in: this module only ever files into the one Drive
 * tree that account owns, so every link is qualified with `authuser=` for
 * it, or a bare link opens in whichever Google profile the browser signed
 * into first.
 */
import "server-only";
import { google } from "googleapis";

const OWNER_EMAIL = "juan@nutribiotic.com";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const SHEET_MIME = "application/vnd.google-apps.spreadsheet";

function auth() {
  const clientId = process.env.NB_EXPENSES_GOOGLE_CLIENT_ID;
  const clientSecret = process.env.NB_EXPENSES_GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.NB_EXPENSES_GOOGLE_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "NB_EXPENSES_GOOGLE_CLIENT_ID / _CLIENT_SECRET / _REFRESH_TOKEN are not set. The expenses UI cannot reach Drive without them.",
    );
  }
  const client = new google.auth.OAuth2(clientId, clientSecret);
  client.setCredentials({ refresh_token: refreshToken });
  return client;
}

function drive() {
  return google.drive({ version: "v3", auth: auth() });
}

function sheets() {
  return google.sheets({ version: "v4", auth: auth() });
}

/** Every Drive/Sheets link this module returns, qualified so it opens in the
 *  account that owns the file rather than the browser's first-signed-in profile. */
export function asOwnerLink(url: string | null | undefined): string {
  if (!url) return "";
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}authuser=${OWNER_EMAIL}`;
}

async function findChild(
  name: string,
  parent: string | null,
  mime?: string,
): Promise<{ id: string; name: string; webViewLink?: string | null } | null> {
  const q = [`name = '${name.replace(/'/g, "\\'")}'`, "trashed = false"];
  if (parent) q.push(`'${parent}' in parents`);
  if (mime) q.push(`mimeType = '${mime}'`);
  const res = await drive().files.list({
    q: q.join(" and "),
    fields: "files(id,name,webViewLink,mimeType)",
    pageSize: 10,
    spaces: "drive",
  });
  const files = res.data.files ?? [];
  return files.length ? (files[0] as { id: string; name: string; webViewLink?: string | null }) : null;
}

export async function ensureFolder(name: string, parent: string | null): Promise<{ id: string; webViewLink?: string | null }> {
  const got = await findChild(name, parent, FOLDER_MIME);
  if (got) return got;
  const res = await drive().files.create({
    requestBody: { name, mimeType: FOLDER_MIME, parents: parent ? [parent] : undefined },
    fields: "id,name,webViewLink",
  });
  return { id: res.data.id!, webViewLink: res.data.webViewLink };
}

export async function uploadFile(
  bytes: ArrayBuffer,
  mimeType: string,
  parent: string,
  name: string,
): Promise<{ id: string; webViewLink?: string | null }> {
  const res = await drive().files.create({
    requestBody: { name, parents: [parent] },
    media: { mimeType, body: bufferToStream(Buffer.from(bytes)) },
    fields: "id,name,webViewLink",
  });
  return { id: res.data.id!, webViewLink: res.data.webViewLink };
}

function bufferToStream(buf: Buffer) {
  const { Readable } = require("node:stream") as typeof import("node:stream");
  return Readable.from(buf);
}

export async function ensureSpreadsheet(
  name: string,
  parent: string,
  tabs: Record<string, string[]>,
): Promise<{ id: string; webViewLink: string }> {
  const got = await findChild(name, parent, SHEET_MIME);
  if (got) {
    await addMissingTabs(got.id, tabs);
    return { id: got.id, webViewLink: got.webViewLink ?? `https://docs.google.com/spreadsheets/d/${got.id}/edit` };
  }
  // Created via the Drive API directly in the parent folder, not
  // sheets().spreadsheets.create(), which always lands in My Drive root
  // first and needs a follow-up move.
  const created = await drive().files.create({
    requestBody: { name, mimeType: SHEET_MIME, parents: [parent] },
    fields: "id,webViewLink",
  });
  const id = created.data.id!;
  if (Object.keys(tabs).length) {
    await sheets().spreadsheets.batchUpdate({
      spreadsheetId: id,
      requestBody: { requests: Object.keys(tabs).map((t) => ({ addSheet: { properties: { title: t } } })) },
    });
    // A spreadsheet always starts with one default "Sheet1" tab; drop it
    // once the real tabs exist.
    const meta = await sheets().spreadsheets.get({ spreadsheetId: id, fields: "sheets.properties(title,sheetId)" });
    const stray = (meta.data.sheets ?? []).find((s) => !Object.keys(tabs).includes(s.properties?.title ?? ""));
    if (stray?.properties?.sheetId != null) {
      await sheets().spreadsheets.batchUpdate({ spreadsheetId: id, requestBody: { requests: [{ deleteSheet: { sheetId: stray.properties.sheetId } }] } });
    }
  }
  for (const [tab, header] of Object.entries(tabs)) {
    if (header.length) {
      await sheets().spreadsheets.values.update({
        spreadsheetId: id,
        range: `${tab}!A1`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [header] },
      });
    }
  }
  return { id, webViewLink: created.data.webViewLink ?? `https://docs.google.com/spreadsheets/d/${id}/edit` };
}

async function addMissingTabs(sheetId: string, tabs: Record<string, string[]>): Promise<void> {
  const sh = sheets();
  const meta = await sh.spreadsheets.get({ spreadsheetId: sheetId, fields: "sheets.properties.title" });
  const have = new Set((meta.data.sheets ?? []).map((s) => s.properties?.title));
  for (const [tab, header] of Object.entries(tabs)) {
    if (have.has(tab)) continue;
    await sh.spreadsheets.batchUpdate({ spreadsheetId: sheetId, requestBody: { requests: [{ addSheet: { properties: { title: tab } } }] } });
    if (header.length) {
      await sh.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: `${tab}!A1`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [header] },
      });
    }
  }
}

export async function tabId(sheetId: string, tab: string): Promise<number> {
  const meta = await sheets().spreadsheets.get({ spreadsheetId: sheetId, fields: "sheets.properties(title,sheetId)" });
  const found = (meta.data.sheets ?? []).find((s) => s.properties?.title === tab);
  if (found?.properties?.sheetId == null) throw new Error(`no tab named ${tab} in that spreadsheet`);
  return found.properties.sheetId;
}

export async function batchUpdate(sheetId: string, requests: object[]): Promise<void> {
  await sheets().spreadsheets.batchUpdate({ spreadsheetId: sheetId, requestBody: { requests } });
}

export async function writeRange(sheetId: string, a1: string, values: unknown[][]): Promise<void> {
  await sheets().spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: a1,
    valueInputOption: "USER_ENTERED",
    requestBody: { values },
  });
}

export async function readColumn(sheetId: string, rangeA1: string): Promise<string[]> {
  const res = await sheets().spreadsheets.values.get({ spreadsheetId: sheetId, range: rangeA1 });
  return (res.data.values ?? []).map((row) => (row[0] != null ? String(row[0]) : ""));
}

export async function nextFreeRow(sheetId: string, tab: string, keyCol: string): Promise<number> {
  const col = await readColumn(sheetId, `${tab}!${keyCol}1:${keyCol}`);
  return col.length + 1;
}

/** A link cell. `numeric` leaves the label unquoted so the cell stays a
 *  number (End Odo doubles as a Distance-formula operand). No url means an
 *  empty cell, a visible gap rather than an unlinked label claiming evidence
 *  that doesn't exist. */
export function hyperlink(url: string | null | undefined, label: string | number | null, numeric = false): string {
  if (!url || label == null || label === "") return "";
  return numeric ? `=HYPERLINK("${url}",${label})` : `=HYPERLINK("${url}","${label}")`;
}
