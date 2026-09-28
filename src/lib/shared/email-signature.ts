/**
 * Display-only: collapse an email signature block to "(signed)". The stored
 * touchpoint is never changed. The block is matched by structure, a
 * "Name | Title" line followed by t./e./a. contact lines, so older emails
 * carrying the same block are caught too.
 */
const NAME_TITLE = /^[^|\n]{2,60}\|[^|\n]{2,60}$/;
const CONTACT = /^[tea]\.\s+\S/i;

export function collapseEmailSignature(kind: string | null | undefined, text: string | null | undefined): string | null | undefined {
  if (!text || !kind || !kind.startsWith("email")) return text;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!NAME_TITLE.test(lines[i].trim())) continue;
    let contact = 0;
    let last = i;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j].trim();
      if (!l) continue;
      if (!CONTACT.test(l)) break;
      contact++;
      last = j;
    }
    if (contact < 2) continue;
    const head = lines.slice(0, i).join("\n").replace(/\s+$/, "");
    const tail = lines.slice(last + 1).join("\n").replace(/^\s+/, "");
    return [head, "(signed)", tail].filter(Boolean).join("\n\n");
  }
  return text;
}
