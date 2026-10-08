# Instant open and offline use

How ClientOS opens with no wait and keeps working in a dead zone, and why it
is built this way. Decided 2026-10-08.

## Decision

Phase 1, built: **a service worker plus the on-device stores the app already
had, plus a bundled offline page in the iOS shell** (options a and c).
Phase 2, not built: a local-first sync layer such as PowerSync (option b).

| Option | Gain | Cost and risk | Verdict |
|---|---|---|---|
| (a) Service worker + IndexedDB, stale-while-revalidate | Every launch paints from the phone; screens and writes work with no signal | Hand-written worker, no new dependency, no spend | Built |
| (b) PowerSync, Postgres to SQLite on the phone | Full local queries, live sync | Its free plan pauses after 7 idle days and caps 2 GB synced a month; it needs Supabase Auth JWTs per user, and this app has PIN sessions and a service-role key, so it needs a JWT issuer and sync rules per rep; the writes path would move to its upload queue; logical replication reads count against the org's near-capped egress | Later, only if (a) falls short |
| (c) Capacitor shell changes | A first launch with no signal shows a real screen instead of a blank one | One native rebuild | Built (errorPath) |

Why not a library such as Serwist: Next 16 builds with Turbopack, and the
Serwist Next plugin targets the webpack build. The worker here is about 300
lines, built from the app's own build output, and has nothing to upgrade.

## How it works

**The worker** (`scripts/sw.template.js`, filled with the build's file list
and served at `/nb/sw.js` by `src/app/sw.js/route.ts`, rendered once at
build time; a file written to `public/` after `next build` is not deployed,
so it is a static route instead. Registered by
`lib/core/sw-register.tsx`, scope `/nb` via the `Service-Worker-Allowed`
header in `next.config.ts`):

- At install it keeps every file under `/_next/static` of the build and the
  six static screens (Visit, Route, Plan, Expenses, Search, Fuel).
- A static screen paints from the phone at once; the network answer refreshes
  the copy for the next open. If that answer is the gate (signed out), the
  screen is sent to the gate.
- `/nb` answers its redirect to `/nb/visit` itself, so the iOS app's launch
  URL never waits on the network.
- Screens that render a rep's data on the server (Clients, Prospect, an
  account, Reports, Outbound) go to the network first and fall back to the
  last copy after 3.5 seconds or with no signal.
- `/api/*` is never touched by the worker. Reads are kept by the app itself
  (`lib/core/api.ts` phone copy, `lib/core/phone-sync.ts` book), writes are
  queued by the app (below).
- On iOS this needs `WKAppBoundDomains` (Info.plist) and
  `limitsNavigationsToAppBoundDomains` (capacitor.config.ts), both set.

**The iOS shell**: `server.errorPath: 'offline.html'` (`www/offline.html`)
shows "No connection" with Try again when the live app cannot load and the
worker has nothing kept yet, the very first launch in a dead zone. It goes
back to the live app on Try again or when signal returns. Changing it needs a
native rebuild: `npx cap copy ios`, then from `ios/App`
`xcodebuild -scheme App -destination id=<UDID> -configuration Release
-allowProvisioningUpdates -allowProvisioningDeviceRegistration build` and
`xcrun devicectl device install app`. The app belongs on the work phone
(devicectl name "NutriBiotic").

**Offline writes**:

- Visit notes and field notes: the visit outbox (`lib/core/outbox.ts`, rules
  in `outbox-core.ts`, tests in `tests/outbox.test.mts`).
- Clock in/out, receipts and trips: the write queue (`lib/core/writeq.ts`,
  rules in `writeq-core.ts`, tests in `tests/writeq.test.mts`). A screen calls
  `submitWrite()` with its Idempotency-Key. It lands: the usual confirmation.
  The server refuses it: nothing is queued, the screen keeps every field and
  shows the reason in red. No signal or a gateway error: it is kept on the
  phone, shown on its card as Unsent and in the unsent count on every other
  screen, and sent on reconnect with the same key. A later refusal stays on
  its card in red with Try again, Edit and Discard. Nothing waits out of sight.
- Idempotency: the key is chosen once per logical write by the screen
  (PORTING.md), sent as the `Idempotency-Key` header (and the
  `idempotency_key` form field for multipart), and every write route scopes
  it `<feature>:<key>` in `lib/core/idempotency.ts`.

## One rep's data, never the other's

- `snap` and `reads` in IndexedDB are keyed `<rep>|<key>` and read back only
  under the signed-in rep (`lib/core/phone-store.ts`).
- `lib/core/rep.ts` `adoptRep()` runs at sign-in (GateForm) and on each
  `/api/me`. A different rep wipes both stores and the worker's rep copies,
  then the page reloads so nothing survives in memory.
- The worker keeps server-rendered screens in a cache named for the rep in
  the response's `x-nb-rep` header (set by `proxy.ts`), and a different rep's
  answer wipes them first.
- Queued writes are never wiped (that would lose work). Each names its rep;
  only that rep's session sends it. As a server-side guard, every queued
  write carries `x-nb-as: <rep>` and `proxy.ts` refuses it with 421 under
  another rep's session; the phone keeps it and retries.

## Bounds

- Build files and static screens: two builds kept, older deleted on activate.
- Rep screens in the worker: at most 60, none older than 7 days.
- Reads: one record per allowlisted path, not painted after 7 days.
- Book: rewritten whole at each sync, dropped if not refreshed in 30 days.
- Queues: only unsent writes, each leaves when it lands or on a tapped
  discard.
- No new Supabase polling. The worker adds no API reads.

## Verified

`pnpm build` then a Playwright run against `next start` with every API call
stubbed (nothing reaches a database or sheet), the server stopped and the
browser offline for the dead zone: the build and six screens are kept; every
static screen and the launch URL open with no signal (about 20 to 45 ms);
clock in/out and a visit note queue, tagged with the rep; on reconnect each
arrives exactly once with its key, and not again after a reload; a rep switch
wipes the first rep's reads and keeps their unsent write, which is refused
under the other rep's session and sent once when the first rep signs back in.

## Phase 2, when

Consider PowerSync (or a similar SQLite sync) only if reps need to search or
query the whole book offline in ways the snapshot cannot answer. Before it:
a JWT issuer for the PIN sessions, per-rep sync rules, its egress measured
against the Supabase org cap, and a paid plan or a keep-alive to avoid the
free plan's 7-day pause.
