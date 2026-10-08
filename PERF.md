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
