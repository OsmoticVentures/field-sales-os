/**
 * A body with a markdown pipe table (Juan, 2026-10-02: an order of more than
 * five items lists name, item number and units in a table). Ported from the
 * NutriBiotic OS's lib/outbound-ui.tsx. An Outlook compose deep link only
 * carries plain text, so a table body would arrive as raw pipes (McCarthy
 * order, 2026-10-14). Instead the link opens addressed and the body is copied
 * as rich text and pasted in.
 */
const TABLE_ROW = /^\|.*\|\s*$/;

export function hasTable(body: string): boolean {
  return body.split("\n").filter((l) => TABLE_ROW.test(l)).length >= 3;
}

export type BodyPart = { kind: "text"; text: string } | { kind: "table"; rows: string[][] };

export function splitBody(body: string): BodyPart[] {
  const parts: BodyPart[] = [];
  let text: string[] = [];
  let rows: string[][] = [];
  const flushText = () => {
    if (text.length) parts.push({ kind: "text", text: text.join("\n") });
    text = [];
  };
  const flushRows = () => {
    if (rows.length) parts.push({ kind: "table", rows });
    rows = [];
  };
  for (const line of body.split("\n")) {
    if (TABLE_ROW.test(line)) {
      flushText();
      const cells = line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      if (!cells.every((c) => /^-+$/.test(c))) rows.push(cells);
    } else {
      flushRows();
      text.push(line);
    }
  }
  flushText();
  flushRows();
  return parts;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function bodyToHtml(body: string): string {
  return splitBody(body)
    .map((p) =>
      p.kind === "text"
        ? esc(p.text).replace(/\n/g, "<br>")
        : `<table style="border-collapse:collapse">` +
          p.rows
            .map((r, i) => {
              const tag = i === 0 ? "th" : "td";
              return "<tr>" + r.map((c) => `<${tag} style="border:1px solid #999;padding:3px 8px;text-align:left">${esc(c)}</${tag}>`).join("") + "</tr>";
            })
            .join("") +
          `</table>`,
    )
    .join("");
}

/** The plain-text twin of a table body, for a paste target that refuses HTML:
 *  each row reads "Item, #sku, units" instead of a run of pipes. */
export function bodyToPlain(body: string): string {
  return splitBody(body)
    .map((p) => (p.kind === "text" ? p.text : p.rows.map((r) => r.join("  ")).join("\n")))
    .join("\n");
}
