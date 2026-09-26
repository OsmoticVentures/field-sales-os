/**
 * PORTED COPY, DO NOT EDIT BY HAND.
 *
 * Source of truth: nutribiotic/config/email_style_rules.json in the agency
 * repo, read directly by bridges/nutribiotic/lib/draft_style.py and carried
 * into the NutriBiotic OS as
 * portfolio/src/app/nutribiotic/lib/email-style-rules.generated.ts by
 * scripts/sync_email_voice.py. This is a manual copy of that generated copy
 * for the same reason the other two files here are: this app cannot see
 * either source repo, so the deterministic style gate needs its own baked-in
 * copy.
 *
 * Rules that need the source note in hand (an invented number, a greeting
 * naming nobody on file, a body that says nothing about this account) are
 * not here. They cannot be written as a pattern over the text, and they live
 * in compose.ts, which is the only side holding the note.
 *
 * DEVIATION FROM THE SOURCE FILE: the em/en-dash pattern below is written
 * with numeric unicode escapes rather than the literal characters the
 * source file carries. Same regex, same behavior; the literal characters
 * would themselves fail this app's own style_check.py, since it scans every
 * line of every file byte for byte and does not know a character class from
 * a sentence.
 */

export type StyleRule = { re: RegExp; why: string };

/** Words and punctuation that are never his, matched anywhere in the text. */
export const BANNED: StyleRule[] = [
  /**
   * A hard rule across the whole agency; jobhunt/scripts/style_check.py
   * refuses a publish over one. Where a dash would go he writes a spaced
   * hyphen, which the voice file records in his own hand. A plain hyphen is
   * allowed on purpose.
   */
  { re: new RegExp(`[${String.fromCharCode(0x2014)}${String.fromCharCode(0x2013)}]`), why: "an em dash or en dash, which he has never allowed anywhere" },
  /**
   * Two queued drafts said "GSE Liquid Concentrate ships at 2 fl oz".
   */
  { re: /\bship(s|ped|ping|ment|ments)?\b/i, why: 'the word "ship", which he never uses' },
  /**
   * An absolute rule of his about NutriBiotic collateral, guarantee or not.
   */
  { re: /no questions asked/i, why: 'the phrase "no questions asked"' },
  /**
   * EMAIL-VOICE.md: writing to a person he uses "Hi" and their first name.
   */
  { re: /\bhi\s+there\b/i, why: '"Hi there", a greeting addressed to nobody' },
  /**
   * He uses them himself, 85 times across the corpus, and the voice file
   * rules that the OS does not: a warm line he meant reads as a sales email
   * when a machine produces it. He adds it himself.
   */
  { re: /!/, why: "an exclamation mark" },
  /**
   * STEMMED, to catch a form the bare phrase would miss.
   */
  {
    re: /\b(circl(e|es|ed|ing)\s+back|touch(es|ed|ing)?\s+base|thought leader|game.?changer|best.?in.?class|move\s+the\s+needle|synergy|cutting.?edge|leverag(e|es|ed|ing)|utiliz(e|es|ed|ing)|spearhead(s|ed|ing)?|facilitat(e|es|ed|ing))\b/i,
    why: "a phrase he hates",
  },
];

/**
 * Each one is contentless by construction: strike it and the email loses
 * nothing a customer could act on. Listed rather than judged because a model
 * writing a short polite email reaches for them every time, and "the prompt
 * said not to" has never once been an enforcement mechanism. Narrow on
 * purpose: "let me know what quantities work" is a real ask and is not here.
 */
export const FILLER: RegExp[] = [
  /let me know (if you (have any|need)|what other|how you(')?d like to proceed)/i,
  /if you have any questions/i,
  /(feel free|do not hesitate|don't hesitate) to (reach out|contact|ask|call)/i,
  /reach out with any questions/i,
  /to move forward/i,
  /at your earliest convenience/i,
  /looking forward to hearing/i,
  /i hope (this|all|you)[^.]{0,40}(well|finds you)/i,
  /hope all is well/i,
  /just wanted to (follow up|check in|reach out|touch)/i,
  /please advise/i,
  /thanks in advance/i,
  /any other information you need/i,
];

export const FILLER_WHY = "a line that says nothing";

/**
 * His mail client adds the block; a draft that types one out sends it
 * twice. EMAIL-VOICE.md, from the corpus: his first name alone, "Juan", not
 * "Juan Arenas": the full block is his auto signature, not something he
 * types. THE NAME ON A LINE OF ITS OWN, never his name in a sentence: a
 * cold-open sentence naming him and the company by name has to survive.
 * SCOPED TO THE TAIL on purpose, since a signature sits at the end, which is
 * what keeps this off a real closing line like "NutriBiotic is made in
 * Lakeport."
 */
export const SIGNATURE_BLOCK = /^\s*(juan\s+arenas[\w\s.]{0,20}|nutribiotic[\w\s,]{0,20})\s*$/i;
export const SIGNATURE_TAIL_LINES = 3;
export const SIGNATURE_WHY = "a typed-out signature block";

/**
 * A composed follow-up is four or five short sentences; past this the model
 * is filling space, and filled space is where invented facts live.
 */
export const BODY_LIMIT = 1200;
export const BODY_LIMIT_WHY = "the draft ran longer than an answer to one ask should";
