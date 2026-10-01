/**
 * "BETTY CIUCHTA, D.C." is a one-person practice registered under her own name
 * and credential. The ERP and HubSpot print that name, so the contact is the
 * person in the account name and the claim is the stored name itself. Port of
 * headhunter_named.py. No imports, so it runs under plain node in the tests.
 */
export type NamedPractitioner = { name: string; title: string; credential: string };

const CREDENTIALS: Record<string, string> = {
  dc: "Doctor of Chiropractic", md: "Physician (MD)", dds: "Dentist (DDS)", dmd: "Dentist (DMD)",
  do: "Osteopathic Physician (DO)", nd: "Naturopathic Doctor", lac: "Licensed Acupuncturist",
  dpm: "Podiatrist (DPM)", phd: "Doctor (PhD)", np: "Nurse Practitioner", pa: "Physician Assistant",
  od: "Optometrist (OD)", rn: "Registered Nurse", dnp: "Doctor of Nursing Practice",
};
const SHAPE = /^([A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*){1,3}?),\s*([A-Za-z.]{2,6})\.?\s*$/;
const NOT_A_NAME = new Set(["the", "and", "of", "health", "clinic", "center", "wellness", "medical", "dental", "chiropractic"]);

function caseWord(w: string): string {
  if (w !== w.toUpperCase() && w !== w.toLowerCase()) return w;
  return w.split("-").map((x) => x.slice(0, 1).toUpperCase() + x.slice(1).toLowerCase()).join("-");
}

export function personFromAccountName(accountName: string): NamedPractitioner | null {
  const m = SHAPE.exec((accountName || "").trim());
  if (!m) return null;
  const cred = CREDENTIALS[m[2].toLowerCase().replace(/[^a-z]/g, "")];
  if (!cred) return null;
  const words = m[1].split(/\s+/);
  if (words.length < 2 || words.some((w) => NOT_A_NAME.has(w.toLowerCase().replace(/\./g, "")))) return null;
  return { name: words.map(caseWord).join(" "), title: cred, credential: m[2] };
}
