/**
 * GENERATED FILE, DO NOT EDIT.
 *
 * Source: assistant/EMAIL-VOICE.md in the agency repo, which is written from
 * Juan's own sent mail by bridges/email_voice/email_voice_scout.py. Regenerate with
 * `python3 scripts/sync_email_voice.py` after that file changes.
 *
 * It lives here as a constant because this app runs on Vercel, where the
 * agency repo does not exist. Editing this copy loses the edit on the next
 * sync; edit the source.
 */

export const EMAIL_VOICE = String.raw`# EMAIL VOICE

How my email actually reads, taken from my own Sent folder rather than from what I say I like.
'assistant/PREFERENCES.md' governs form across everything the agency writes. This file governs
email only, and where the two meet it defers to PREFERENCES. Nothing here is a guess: every rule
carries a line I actually sent, and the corpus behind it is rebuilt with

    python3 bridges/email_voice/email_voice_scout.py fetch      # Gmail
    python3 bridges/email_voice/email_voice_scout.py outlook    # juan@nutribiotic.com
    python3 bridges/email_voice/email_voice_scout.py zoho       # juan@osmoticventures.com
    python3 bridges/email_voice/email_voice_scout.py run        # all of it, daily at 06:30
    python3 bridges/email_voice/email_voice_scout.py edits      # OS drafts I rewrote

Corpus as of 2026-09-17: 224 emails I wrote myself, after the scout dropped reports, self-sends,
Zoom invites and anything an agent composed for me. 143 from 'juan.arenas.rec@gmail.com' and
'juanpro044@gmail.com', and 81 from 'juan@nutribiotic.com' between 2026-07-28 and 2026-09-17. That
tenant blocks Graph, so the NutriBiotic mail comes through the browser profile I signed into myself
('bridges/gmail/outlook_scrape.py'), which reads Sent Items and touches nothing.

That second mailbox is where the field voice lives. Everything below marked NutriBiotic comes from
it, and none of it was visible when this file was written from Gmail alone.

## What an email from me does

Most of what the OS drafts for me is a first email to a store or a clinic. The drafter's habit was
to write a report of my visit note. I rewrite every one into a pitch: an appointment, or a straight
ask for the sale. A draft that only restates the note is not finished. This section comes from
eight drafts I rewrote before sending, 2026-08-18 to 2026-09-23, each paired with what I sent.

**Everyone I know on their team, in the first two lines.** Who connected us, who I met, who I am
writing to. It shows I care. "Following up after meeting with Carmen." / "Hi Honey and Susan," /
"Miriam told me this address is the way to reach Mehrdad." / "come see you and Silvia/Carmen".

**Who I am, in one line, in a first email.** "I'm Juan, your representative with NutriBiotic." /
"I'm Juan, the new representative for NutriBiotic." Not in a reply to something they sent me.

**The relationship, not the data.** Draft: "Better Life has been buying NutriBiotic steadily ...
with the last order on April 27." Sent: "Your company has been trusting NutriBiotic for years."
Order dates and order history are my notes, not their news.

**A reason that helps them sell.** Helping them sell our products and inform their customers is my
job as their rep, so every first email says how I will do it. Draft: "go through what is moving,
what is not." Sent: "help you sell our products better." / "My goal is to help you explain the
products, so your team can better inform customers to make buying decisions." / "help you better
sell the GSE products you carry" / "see if our products would be a good fit for your patients."

**One hook from what is new, when it fits.** A line from 'nutribiotic/config/talking_points.json',
never more than one or two: "This year the company joined forces in Europe with lab in Spain,
combining 45+42 years of experience." / "NutriBiotic is innovating with 4 new products per year."

**The ask is mine to propose, and small.** I offer times from my own schedule rather than asking
them to pick: "September 29th afternoon and 30th morning I'll be in the area." / "Do you have 15
minutes on Thursday or Friday mornings? I'm also available next Monday." / "How is Wednesday Oct
14?" Draft lines like "Tell me the day and time" and "Which Wednesday do you want it?" are the
ones I rewrite. Fifteen minutes is the usual size: "Just 15 minutes should be good." When they are
ready to buy, the ask is the order itself: "Let me know what order size makes sense, and I'll get
that processed for you."

**Relative time, not dates.** They do not care whether it was September 2 or September 3. "a
couple weeks ago", "recently", "two days ago". An exact day only when it is very recent. Draft:
"Nikki told me on September 2 that email is the way to ask you for a meeting, with at least a week
of notice." Sent: "Nikki told me recently that email is the best way to reach you for a scheduled
meeting."

**No logistics they already know or that go without saying.** "with at least a week of notice",
"I understand you're available Tuesday and Wednesday mornings", "so I am writing here" all came
out.

**An attachment always says what to do with it.** Never "attaching X" on its own. "They may be
helpful to print and show to customers." / "I attached our best seller guide so you can see all
products and prices. You can either email me with your order or fill out the last page of the pdf
and send it back, either works."

**First emails run longer than replies.** Five or six short paragraphs of one or two sentences
each. The one-idea-per-paragraph rule holds; the count goes up.

## The numbers behind this

- Median sentence: 8 words. Mean 10.3.
- Median paragraph: 1 sentence.
- Long dashes in 224 emails: 19, across six messages, and worth being straight about. Five sit
  inside one assembled request to a CPA. Three are mine in annoyed complaints to vendors: "They
  were missing the logo -the". Ten more are one NutriBiotic order list where I used the dash as a
  column rule, "GSE Liquid Concentrate, #1000 - 20u", ten items in a row. So I reach for it in a
  list, almost never in a sentence, and it is still a rule I hold the agency to. In prose, where a
  dash might go, I use a spaced hyphen: "Let me know your preferred place - I'll be out in the
  field so I can adjust my schedule."
- 140 of 224 open with no greeting at all. Those are replies.

## How I open

First name, nothing else: "Hi Ashley,". Never "Dear", never "Hi there", never "I hope this email
finds you well".

Replying, I usually skip the greeting and answer: "Glad I can help." / "Awesome. I'm glad this is
looking up." / "Yes. I moved my conflicting meeting so we can chat at 6pm ET Today."

The greeting and the news can share a line when there is real news: "Hi Victor - exciting news!"

With people I know well I open in Spanish: "Hola," and, to the group in Madrid, "Buenos días Héctor
y Francesco."

## The body

One idea per paragraph, and the paragraph is usually one sentence.

I lead with what I did, not what I intend: "Letting you know I contacted Neelima Firth and Nancy
Yopp for help with Bilisense." / "I sent you an invite for 5pm." / "I've built out the marketing
plan for the next 6 months for what you described on our call."

I say why, not just what: "I'd like to walk you through it live rather than send it over cold."

I name people and facts concretely, never vaguely: "The founder of Bilisense, Victor Ong, USC PhD,
is building a bilirubin sensor to detect jaundice in neonates before it becomes a problem."

Warmth is a specific sentence about them, never a formula: "Lovely meeting you yesterday." / "I've
been wanting to reach out to you. I'm glad I got the perfect excuse yesterday at a biotech event!"
/ "I heard you work Sundays, so I wanted to bring this up when it would be convenient for you."

**NutriBiotic.** With HQ I sometimes end the greeting with a colon instead of a comma, and I
shorten the names: "Hi Kenny & Pam:", "Hi Cheryl:", "Hi Kenny and Fra:". Four of my 34 greetings
there, so it is a habit and not a rule.

## How I ask

The ask is one sentence, and it offers two concrete options with a timezone.

- "How's Monday or Tuesday next week, 1 to 3pm Pacific?"
- "How's Thursday at 5pm or 7pm ET instead?"
- "Yes, how is 10:30 AM PT, tomorrow Wednesday 26th? Same time Thursday also works for a brief call."
- "I plan on sending biweekly expense reports, is end-of-week 2, and end-of-week 4 of every month a
  good time?"

When the ask depends on them wanting it, I say so first: "If this interests you, I'd like to
introduce you to Victor."

**NutriBiotic, and this is the pattern the Gmail corpus never showed.** When I need specifications
out of a buyer or an answer out of HQ, I do not write a paragraph around the questions. I stack
them bare, one per line, no numbering, no padding between them:

    Ascorbic Acid (classic Vitamin C) or Sodium Ascorbate (neutralized, better for stomach)?
    Powder or pills?
    When would you need the first 1000 bottle order?
    What is your monthly sell-through? You mentioned 288 units

Each line is a decision the other side can answer in three words, and the parentheses carry the
reason I am asking. Same shape to HQ: "Is it a requirement to buy in bulk from NB? / Do we need
their Seller's Permit if they use the products instead of reselling to their clients? / Do we have
an online application process that collects this or other wholesale buyer data?"

## How I close

Always appreciation, then my first name alone. "Juan", not "Juan Arenas": the full block is my auto
signature, not something I type.

- "Thank you," is the default, 39 times in the corpus, more than every other close combined, and
  the line I add most often to a draft that ended without one.
- "Thanks," for a short one, and "Thanks Jeremy!" with someone I know.
- "Gracias," to a Spanish-speaking buyer, even when the email is in English.
- "See you again soon." after a visit, above the appreciation line.

## Registers

**A client or a prospect.** Greeting by first name, what I built or did, why it matters to them,
one concrete time ask. Ashley at Metri Bio, Neelima, Victor.

**A store buyer I just called on.** I open with the person I actually met, by name, and what they
told me, before I get anywhere near a product: "Following up after meeting with Carmen. She
mentioned you are looking to make changes in your vitamin section. I'm here to help with what's
selling the most this year." Then one product, tied to what that person said their shoppers want,
never a catalogue: "Carmen said your clients look for electrolytes and multivitamins, so I believe
NutriBiotic's Electro-C is a fit to get an electrolyte in your shelf."

**A NutriBiotic colleague.** Answer first, number second, process third, one confirming question
last: "Yes, you are correct. The total field expenses and mileage for days 8/3 to 8/7 added up to
$388.08." Then the open question, and I offer to do the extra work myself: "Will you need the
physical receipts? I can mail them to Lakeport if that is the case."

Relaying a customer to HQ, I hand over their answers as a list and then count what I am asking for,
so nobody has to add it up: "Press-on cap is okay. / No docs required for now. / Label art will be
provided, yes." then "In total, 8 quotes requested." I also say plainly why it matters to us: "Our
biggest client here in SoCal has issues with their vitamin C provider. They consider switching to
us if we can provide the private label service."

**The group in Madrid, and Spanish-speaking buyers.** Spanish, one warm real sentence before
business, then the terms as a list. "Muy bien. Estoy listo para incorporarme en cuanto tengamos el
plan listo. Quedamos en contacto." Short agreements stay short: "De acuerdo, sin problema. Quedo
atento a las fechas y lo coordinamos así." I close them "Un saludo," or "Gracias," or "Un abrazo,".
I switch language for the person, not the company: Letty at NHC gets "Hola Letty," and then English,
because the business words are English.

**A recruiter or a vendor.** Shortest of all. Two lines and a time: "Sounds good. Talk to you soon."

## Never

- No em dash anywhere. Nineteen in 224 emails, and every one of them is either pasted, typed in
  irritation, or used as a column rule in a list I was typing fast. None is in a sentence I wrote
  to a customer, which is the whole case for the rule rather than an exception to it.
- No "Hi there", no greeting addressed to nobody. "Dear" appears once in the whole corpus, in that
  same assembled document; writing to a person I use "Hi" and their first name.
- No "I hope this email finds you well", no preamble before the point.
- No "circle back", "touch base", "leverage", or anything else in the phrases-I-hate list in
  PREFERENCES.md.
- Never the word "ship".
- No paragraph that says nothing. If a line does not carry a fact, an ask or a specific kindness,
  it comes out.

## One honest tension

I use exclamation marks with people I know: 85 across the 224 emails, 49 of those in NutriBiotic
mail, in lines like "Hope you're rocking it today. Keep it up!" and "First order coming from a SoCal
client!" PREFERENCES.md says the agency writes without them. Both are true.
When I write, I use them. When the OS drafts in my name, it does not, because a warm line I meant
reads as a sales email when a machine produces it. The drafter stays flat and lets me add the
exclamation myself.

## How this file changes

Gated, the same way PREFERENCES.md is. The scout re-reads my Sent folder, rewrites its digest, and
prints what moved. A change to this file is proposed to me and applied only once I say so. Nothing
here edits itself.
`;
