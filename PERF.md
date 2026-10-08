# Load performance

What each screen costs to load, how it was measured, and what changed it.
Re-run the two scripts after any change to a read or a screen and add a row.

## How it is measured

| Measure | Command | What it reports |
|---|---|---|
| First-load JS | `pnpm build && node scripts/perf/first-load.mjs .next` | Per page, every JS chunk a cold load fetches, raw and gzip |
| Server render and reads | `pnpm build && node scripts/perf/measure.mjs` | Per screen or read, against `scripts/perf/fake-postgrest.mjs`: render time cold and warm, response size, database requests and bytes, and a hash of what the screen shows |
| Production round trip | `curl -w '%{time_starttransfer}' https://osmoticventures.com/nb/api/health` | Network plus function start, from where the rep is |

The fake database serves synthetic rows sized to the real book (about 1,100
accounts, Juan's open book about 450, Kyle about 330, 3,200 orders, 2,600
activities; `scripts/perf/seed.mjs`). No production key or PIN is used; the
script signs in with a session minted from a throwaway local secret. Absolute
milliseconds are a laptop's, so read them as before and after, not as the
phone's. Byte counts are real for the synthetic rows and track production in
proportion; the last production measure of the priority book was about 515 KB
(2026-10-02, prospect/dal.ts).

The `shown` hash is what the screen displays (visible text for a page, the
JSON for a read). A change that only makes a screen faster keeps it the same.

## Where the app runs

| Piece | Region | Check |
|---|---|---|
| Vercel functions | yul1, Montreal (`vercel.json`) | `x-vercel-id` header ends `::yul1::` |
| Supabase "nutribiotic" | AWS ca-central-1, Montreal | database host's IPv6 is in AWS's published ca-central-1 range |

Same city, so each read inside a request is a short hop. The phone to Montreal
round trip from California is about 220 ms for the health route (2026-10-08,
three runs 219 to 240 ms), which is why a screen makes one request, not five.

## Baseline, 2026-10-08 (main at 0a650fa)

First-load JS, gzip. About 148 KB of it is the framework every page shares.

| Page | gzip KB |
|---|---|
| /route | 180.8 |
| /prospect | 176.0 |
| /search | 173.4 |
| account slide-over | 170.6 |
| /account/[id] | 165.4 |
| /visit | 163.2 |
| /fuel | 163.0 |
| /expenses | 160.5 |
| /reports | 159.8 |
| /clients | 158.9 |
| /outbound | 158.5 |
| /plan | 158.1 |

Server render and reads:

| Path | cold ms | warm ms | response KB | db requests | db KB |
|---|---|---|---|---|---|
| /nb/clients | 292 | 185 | 5,152 | 8 | 283 |
| /nb/prospect | 85 | 19 | 209 | 19 | 933 |
| /nb/reports | 66 | 9 | 32 | 6 | 1 |
| /nb/outbound | 87 | 10 | 26 | 3 | 0 |
| /nb/account/[id] | 114 | 17 | 44 | 23 | 916 |
| /nb/api/route/state | 70 | 22 | 287 | 8 | 368 |
| /nb/api/route/map | 46 | 3 | 52 | 17 | 913 |
| /nb/api/route/returns | 43 | 3 | 0 | 16 | 912 |

What stands out:

1. **Clients is 5.2 MB of HTML** (104 KB gzipped). Every account in the book
   renders twice (phone list and desktop table), each row with ten picker
   buttons and three inputs, and every one hydrates. The phone parses and
   hydrates all of it before the screen responds.
2. **The priority book reads everyone's rows.** Prospect, the Route map,
   Suggested returns and a cold client view all build it: the rep's accounts,
   then every account's grade, every order, every activity and every order
   email in the database, both reps' and the unowned ones, to score only the
   rep's own accounts.
3. **Route state merges two whole views.** Grades (first 1,000 rows of every
   account) and lead stages (first 2,000) are read unfiltered and matched to
   the rep's accounts in code. Past 1,000 accounts in the database, some of
   the rep's pins silently lose their grade.
4. **Clients reads the book three times.** Once for the list, once more as
   500 ids for hours, once more as the same 500 ids for metrics, and a fourth
   time as up to 2,000 ids to filter the pipeline.
5. The bundle is already lean: no map, chart or PDF library ships to the
   phone (Google Maps loads as a script on Route and Search only).

## Changes

### 1. Clients: one book read, the list drawn a page at a time

- The list ships every row's data but draws the first 40 rows; the next 80
  are drawn whenever the end of the list is within about two screens.
  Order, values and the page's other text are unchanged (checked: the same
  404 synthetic rows in the same order, header and weekly review text equal).
- Hours, the four metrics and readiness come from one read of the book,
  filtered by owner rather than by 500 ids, and it runs alongside the list.
  The pipeline is filtered with the same read, so the separate 2,000-id read
  is gone. The tier view and stale-deal view return only the columns drawn.

| /nb/clients | cold ms | warm ms | response KB | db requests | db KB |
|---|---|---|---|---|---|
| before | 415 | 195 | 5,152 | 8 | 283 |
| after | 105 | 33 | 558 | 6 | 169 |

### 2. Priority book and Route state read only the rep's rows

- The priority book reads the rep's accounts first, then scopes every other
  read to their ids, 300 ids per request: grades, orders, touches, notes,
  corporate notes and order emails. Touches ask only for the activity kinds
  the score uses. The order emails read used to stop at 1,000 rows; it now
  pages through all of the rep's.
- Route state reads grade and lead stage for the rep's mapped accounts by
  id instead of the first 1,000 and 2,000 rows of everyone's, which also
  stops a pin losing its grade once the database passes 1,000 accounts.
- Same output: the shown hash of Prospect, the client view, Route state and
  the Route map is unchanged.
- Cost: a cold book build now waits for the accounts read before the rest
  start, one extra in-region hop. The book is kept ten minutes per server,
  so this lands on about one load in ten minutes.

| Path | db KB before | db KB after | db requests before / after |
|---|---|---|---|
| /nb/prospect | 933 | 457 | 19 / 19 |
| /nb/account/[id] (cold book) | 916 | 441 | 23 / 23 |
| /nb/api/route/state | 368 | 314 | 8 / 10 |
| /nb/api/route/map | 913 | 437 | 17 / 17 |
| /nb/api/route/returns | 912 | 436 | 16 / 16 |

On the synthetic seed the other rep and unowned accounts are about 60% of
the database, so the book drops by about half. In production the drop is
whatever share of orders and activities sits outside the rep's own book.

### 3. Client view and the twice-daily download name their columns

- The account payload (one client, and the whole-book download the phone
  takes twice a day) read `nb_accounts` and `nb_contacts` with `select=*`
  and then kept only the keys it draws. It now asks for those keys, plus
  readiness and lead status.
- The full client page's title read the whole account row a second time;
  it now reads the name.
- `getClientAccount` (outbound drafting) asks for its typed columns only.
- Same output: the download is equal field for field once its build
  timestamps are set aside, and the page title is unchanged.

| Path | db KB before | db KB after |
|---|---|---|
| /nb/api/account/snapshot | 1,804 | 1,370 |
| /nb/account/[id] | 441 | 438 |

The seed's account rows are narrower than production's (no enrichment or
sync history in the json columns), so production saves more than this.

### 4. Route and Clients reuse the rep's account rows until they move

Route reads the rep's mapped accounts on every open, and Clients reads the
book's hours and metrics on every open. Those are plain `nb_accounts`
columns, which the `accounts_touch` trigger stamps on every update. Each warm
server now keeps the last read per rep with a fingerprint (how many accounts
the rep owns, and the newest `updated_at`), asks for the fingerprint first,
about a hundred bytes, and reads the rows again only when it moved
(`lib/shared/owned-fingerprint.ts`). Grades, lead stages and the tier list
come from other tables, so they are still read fresh every time.

Checked on the seed: an edit to one account shows on the next Route read;
a read with no edit in between returns the same JSON.

`measure.mjs` now also reports `warm_db_kB`, the database bytes per request
once the server is warm, which is what a rep opening a screen again costs.

| Path | warm db KB before | warm db KB after |
|---|---|---|
| /nb/api/route/state | 314 | 44 |
| /nb/clients | 168 | 67 |

## Looked at, left as is

- **Splitting the map and other big client pieces into lazy chunks.** The
  whole Route screen costs 33 KB gzip over the shared framework, and the map
  has no library behind it. A lazy chunk would also be one more file the
  phone must have fetched before it can draw the screen with no signal, so it
  trades offline safety for a few KB on the first load after a deploy.
- **Vercel region.** Already beside the database (see above).
- **New indexes.** Every scoped read filters a table of about a thousand
  accounts or reads by `account_id`, which the baseline indexes cover; none of
  the changes above needs a new one.
- **Production timings.** Screens behind the PIN are measured on the seed,
  not in production: no rep session or production key is used for this work.
