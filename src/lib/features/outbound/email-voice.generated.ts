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

Corpus as of 2026-10-20: 289 emails I wrote myself, after the scout dropped reports, self-sends,
Zoom invites, anything an agent composed for me, and anything carrying a card or account number.
152 from 'juan.arenas.rec@gmail.com' and 'juanpro044@gmail.com', and 137 from 'juan@nutribiotic.com'
between 2026-07-28 and 2026-10-20. That
tenant blocks Graph, so the NutriBiotic mail comes through the browser profile I signed into myself
('bridges/gmail/outlook_scrape.py'), which reads Sent Items and touches nothing.

That second mailbox is where the field voice lives. Everything below marked NutriBiotic comes from
it, and none of it was visible when this file was written from Gmail alone.

## What an email from me does

Most of what the OS drafts for me is a first email to a store or a clinic. The drafter's habit was
to write a report of my visit note. I rewrite every one into a pitch: an appointment, or a straight
ask for the sale. A draft that only restates the note is not finished. This section comes from
19 drafts I rewrote before sending, 2026-08-18 to 2026-10-20, each paired with what I sent.

**Everyone I know on their team, in the first two lines.** Who connected us, who I met, who I am
writing to. It shows I care. "Following up after meeting with Carmen." / "Hi Honey and Susan," /
"Miriam told me this address is the way to reach Mehrdad." / "come see you and Silvia/Carmen".

**Where the person who sent me works, when they have more than one location.** Draft: "Clinton
mentioned" / Sent: "Clinton from your Silverlake location mentioned you're the right person to
talk to". With one location, the name alone.

**Who sent me comes before who I am, and when.** Draft: "I'm Juan, your representative with
NutriBiotic. I spoke with Ashley Rose at Robertson Pharmacy recently" / Sent: "I spoke with Ashley
Rose in your Pharmacy today, and she told me you will be the right person to talk to. I'm Juan,
..." "Today" when it was today. (Once, 2026-10-20.)

**When I last walked in, and how I got to this person.** "I came in your pharmacy a month ago and
brought Electro-C electrolytes. This week I met Kevin at the pharmacy, who directed me back to you."
/ "Julie and Angel from the supplements team at Lazy Acres Long Beach put me in touch with you after
a few visits." (Twice.)

**Who I am, in one line, in a first email.** "I'm Juan, your representative with NutriBiotic." /
"I'm Juan, the new representative for NutriBiotic." Not in a reply to something they sent me. To
someone who may not know us, the line says what the company is: "I'm Juan, your representative
with NutriBiotic, an immunity-focused supplements manufacturer in CA since 1981."

**Say what their store already does with us, in their words.** "The Long Beach store already carries
several NutriBiotic lines, and the team has tried and liked these two new products." Not a list of
who likes which product. (Three times.)

**The relationship, not the data.** Draft: "Better Life has been buying NutriBiotic steadily ...
with the last order on April 27." Sent: "Your company has been trusting NutriBiotic for years."
Order dates and order history are my notes, not their news.

**A reason that helps them sell.** Helping them sell our products and inform their customers is my
job as their rep, so every first email says how I will do it. Draft: "go through what is moving,
what is not." Sent: "help you sell our products better." / "My goal is to help you explain the
products, so your team can better inform customers to make buying decisions." / "help you better
sell the GSE products you carry" / "see if our products would be a good fit for your patients."

**Why this product fits them, in one sentence.** Not an offer to explain later. Draft: "happy to
walk through how those differ ... whenever it's useful" / Sent: "This is a staple in sports
medicine, especially for rehab and older adults when hydration is essential."

**A gap I saw on their shelf, not what staff told me.** Draft: "she told me you are the owner and
manager" / "She mentioned you have about eight shelves of supplements." Sent: "I saw you carry a
few immune C products, but I saw the shelves are missing some best sellers in the industry like
throat and nasal sprays." What a staff member passed along stays in my notes. (Once, 2026-10-20.)

**To an owner, ask what drives their sales, then the proof.** Draft: "My goal is to help you sell
our products better and help your team inform customers so they can make buying decisions." Sent:
"I'd like to understand what products drive supplement sales for you and show you how I've helped
dozens of Pharmacies in LA increase their monthly revenue." A results claim like that is mine to
make; the drafter never writes one on its own. (Once, 2026-10-20.)

**Offer a sample when a new product is on the table.** "Happy to send you a sample so you and your
team can try these products." (Twice.)

**One hook from what is new, when it fits.** A line from 'nutribiotic/config/talking_points.json',
never more than one or two: "This year the company joined forces in Europe with lab in Spain,
combining 45+42 years of experience." / "NutriBiotic is innovating with 4 new products per year."

**The ask is mine to propose, and small.** I offer times from my own schedule rather than asking
them to pick: "September 29th afternoon and 30th morning I'll be in the area." / "Do you have 15
minutes on Thursday or Friday mornings? I'm also available next Monday." / "How is Wednesday Oct
14?" Draft lines like "Tell me the day and time" and "Which Wednesday do you want it?" are the
ones I rewrite. In a cold first email, one day and one time, and no length: "Let's coordinate for
next week: are you available Tuesday 27th at 1pm?" I cut "Just 15 minutes should be good." from
that draft (2026-10-20). When they are ready to buy, the ask is the order itself: "Let me know what
order size makes sense, and I'll get that processed for you."

**A concrete day, every time.** My most repeated edit. "Will you be in on Tuesday Sep 29th? I'd like
to come visit in the morning." / "How is Wednesday Oct 14?" Never an open-ended "let's find a time".
In September I also named the minutes ("a short 10 minutes with Dr. Ganem"); since October I leave
them out of a cold ask.

**Two ways to meet, and an easy out.** "I can come to any of the Yummy locations to meet you or
just give you a quick phone call." / "If you aren't looking for supplements at all, please let me
know and I won't bother you."

**To a clinic, ask to see the practitioners as a request, not a question.** Draft: "Who decides
what supplements the clinic carries?" / Sent: "I'd like to come see if the ND and DCs in your
facility are open to incorporating supplements in their practice."

**Relative time, not dates.** They do not care whether it was September 2 or September 3. "a
couple weeks ago", "recently", "two days ago". An exact day only when it is very recent. Draft:
"Nikki told me on September 2 that email is the way to ask you for a meeting, with at least a week
of notice." Sent: "Nikki told me recently that email is the best way to reach you for a scheduled
meeting."

**No logistics they already know or that go without saying.** "with at least a week of notice",
"I understand you're available Tuesday and Wednesday mornings", "so I am writing here" all came
out.

**One topic.** A side question comes out of a pitch, even one they asked. Draft: "On your question
about returns: yes, we do them ..." / Sent: nothing.

**Orders and confirmations.** The item list is always a table, Item, Item # and Units, however
short the order. In the confirmation to the client, the price column reads "Wholesale price", not
"Unit price"; the total line reads "Total: $1,202.36. Shipping is complimentary." rather than
"before shipping and tax"; a discount names its condition, "(25% off first purchase)"; and it ends
"I'll update you when we process these internally." The note to the orders desk opens with what
the order means when it is a big one, "Big order for New Frontiers Natural Marketplace (Solvang):",
and can end on a line like "So excited to be making some better sales."

**Discounts and terms are HQ's to state, so I say leadership is involved.** The drafter wrote out the
case-pack tiers and the opening-order tiers; I cut them in both sends and wrote what happens next.
Draft: "Ordering in case packs, you get 10% off at 48 units of one SKU, 15% at 96, and 20% at 144."
Sent: "I'm getting leadership involved on my side to get you deals that make sense with how you
order." / "I'll update you once we have updated volume discounts for you." And I do not dictate the
application steps: "Please send your onboarding docs so we can review and sign as well."

**Send the sheets and let them read at their own pace.** Instead of "Tell me the quantities and I
will get it written up." I attach the price list or product sheets: "Here are the product sheets.
I'll let you digest the information." / "I'm sending over the NutriBiotic B2B terms and our price
list so you can browse at your own speed." (Three times.)

**A training offer.** Recall what they told me, name the topics as bare lines, give one date and
flex: "In September you told me you would benefit from a training for your supplements team. / I'm
planning flu season trainings in which I cover / Grapefruit Seed Extract / Vitamins C, D3, Zinc /
Would you like a training for your team on Oct 26th morning? I'm available when it fits your
schedule best." (Two sends, 2026-10-19.)

**An attachment always says what to do with it.** Never "attaching X" on its own. "They may be
helpful to print and show to customers." / "I attached our best seller guide so you can see all
products and prices. You can either email me with your order or fill out the last page of the pdf
and send it back, either works."

**First emails run longer than replies.** Five or six short paragraphs of one or two sentences
each. The one-idea-per-paragraph rule holds; the count goes up.

## The numbers behind this

- Median sentence: 8 words. Mean 10.1.
- Median paragraph: 1 sentence.
- Long dashes in 289 emails: 19, across six messages, and worth being straight about. Five sit
  inside one assembled request to a CPA. Three are mine in annoyed complaints to vendors: "They
  were missing the logo -the". Ten more are one NutriBiotic order list where I used the dash as a
  column rule, "GSE Liquid Concentrate, #1000 - 20u", ten items in a row. So I reach for it in a
  list, almost never in a sentence, and it is still a rule I hold the agency to. In prose, where a
  dash might go, I use a spaced hyphen: "Let me know your preferred place - I'll be out in the
  field so I can adjust my schedule."
- 168 of 289 open with no greeting at all. Those are replies.

## How I open

First name, nothing else: "Hi Ashley,". Never "Hi there", never "I hope this email finds you
well".

"Dear" for a formal first email: someone senior I have not met, a possible partner, a contract, a
complaint. "Dear Bob," to a pharmacy owner (2026-10-20), "Dear Hiroko," to a possible private-label
partner (2026-10-16), "Dear Kenny and Pam," on my contract (2026-08-06), "Dear Gary," asking an
accountant for a quote. Nine times in the corpus. Everyone else gets "Hi" and a first name.

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

Asking several people at HQ in one email, each question carries the name of who should answer it:
"(Cheryl) Could you send me our new client application?" / "(Fra) Can we get them started with 2x2
or 3x3 for the first order of these items?"

## How I close

Always appreciation, then my first name alone. "Juan", not "Juan Arenas": the full block is my auto
signature, not something I type.

- "Thank you," is the default, 57 times in the corpus, more than every other close combined, and
  the line I add most often to a draft that ended without one. It holds after an ask too: "are you
  available Tuesday 27th at 1pm?" then "Thank you," and "Juan" (2026-10-20).
- "Thanks," for a short one, and "Thanks Jeremy!" with someone I know.
- "Gracias," to a Spanish-speaking buyer, even when the email is in English.
- "See you again soon." after a visit, above the appreciation line.
- A draft that ends on a bare name or "Thanks, Juan" gets "Thank you," and then "Juan". I made that
  edit four times. With someone who helped me, the warmer close: "Happy to connect." / "Thank you
  for your help. Means a lot."

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

**An inbound inquiry from a possible partner.** Warm line, then "Here's what NutriBiotic can and can't
do for your company so far:" and the capabilities as bare lines, then the open question: "Let me know
if you think there is a fit and what you would be interested in." (One example, 2026-10-16, to a
private-label prospect.) Capabilities come from 'talking_points.json', not memory.

**Relaying a customer's status to HQ or accounting.** Who, what they said, what I do next and when:
"I spoke with Paula (owner) today and confirmed they're busy with some urgent fires now. Monday
morning I'll reach her over email and send you the details." / "She is still finishing up a massive
expansion to her 3 stores and will get us the card details on Monday of the coming week. I will be
more insistent on this." Closes "Thank you for your patience and trust." Three times in October.

**A recruiter or a vendor.** Shortest of all. Two lines and a time: "Sounds good. Talk to you soon."

## Never

- No em dash anywhere. Nineteen in 289 emails, and every one of them is either pasted, typed in
  irritation, or used as a column rule in a list I was typing fast. None is in a sentence I wrote
  to a customer, which is the whole case for the rule rather than an exception to it.
- No "Hi there", no greeting addressed to nobody.
- No "I hope this email finds you well", no preamble before the point.
- No "circle back", "touch base", "leverage", or anything else in the phrases-I-hate list in
  PREFERENCES.md.
- Never the word "ship".
- No paragraph that says nothing. If a line does not carry a fact, an ask or a specific kindness,
  it comes out.

## One honest tension

I use exclamation marks with people I know: 89 across the 289 emails, 55 of those in NutriBiotic
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
