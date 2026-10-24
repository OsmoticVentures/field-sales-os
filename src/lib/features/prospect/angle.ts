/**
 * The line between the Angle and the card under it. The card owns every
 * number, date, count and state (lifetime value, last purchase, due purchase,
 * status, main purchases); the Angle owns the read a rep cannot see there.
 * An Angle that restates a card fact is how Spice of Life came to read "a
 * dormant account with $188 lifetime" over a card saying $6,916 and Active
 * (Juan, 2026-10-23).
 *
 * Mirrored in bridges/nutribiotic/angle_refresh.py (CARD_FACTS), which
 * rewrites the book's Angles on the Max plan; change both together.
 */
const MONTH = String.raw`(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? \d{1,2}(?:, \d{4})?`;
const ORDER_WORD = String.raw`(?:order|ordered|ordering|purchas\w*|bought|reorder\w*|invoice\w*)`;

const CARD_FACTS: RegExp[] = [
  /\$\s?\d/i,
  /\b\d[\d,]*\s+(?:orders?|invoices?|purchases?|units)\b/i,
  /\blifetime\b/i,
  /\b(?:dormant|lapsed|inactive|churned|reactivat\w*)\b/i,
  /\bactive\s+(?:\w+\s+)?(?:account|customer|client)\b/i,
  /\b(?:zero|no)\s+(?:\w+\s+)?(?:orders?|purchase history|purchases|order history)\b/i,
  /\b(?:overdue|reorder (?:was |is )?due|due (?:for|to) reorder)\b/i,
  new RegExp(String.raw`\b${ORDER_WORD}\b[^.]{0,50}\b${MONTH}`, "i"),
  new RegExp(String.raw`\b${MONTH}\b[^.]{0,30}\b${ORDER_WORD}\b`, "i"),
  /\b(?:most recently|last) (?:on|in)\b/i,
];

export function statesCardFact(text: string | null | undefined): boolean {
  return !!text && CARD_FACTS.some((re) => re.test(text));
}

/** A field that restates the card renders absent, never a contradiction. */
export function angleField(text: string | null | undefined): string | null {
  return text && !statesCardFact(text) ? text : null;
}
