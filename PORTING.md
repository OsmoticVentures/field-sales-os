# Porting a feature into Field Sales OS

The recipe every port after Expenses (m7) follows: Search Map, Route Planner,
Visit Logger, Prospecting Agents, Reports, Fuel Routing. Read this whole file
before touching code. Source app: `portfolio/src/app/nutribiotic` (and
`portfolio/src/app/gas` for Fuel Routing). Never edit the source app; it keeps
running unchanged. Never touch another feature's folder.

## Folder layout

```
src/
  app/
    (app)/                    route group: every signed-in screen shares
      layout.tsx               this shell (nav, hasAccess gate). Add your nav
                                item to NAV in this file, one line.
      expenses/                a feature's UI lives at (app)/<feature>/
        page.tsx
        <Feature>Client.tsx
        loading.tsx
        manifest.webmanifest/route.ts   (if the feature gets its own Home
                                          Screen tile, see Launchers below)
    api/
      expenses/                a feature's route handlers live at api/<feature>/
        <verb>/route.ts
    gate/                      shared core, don't touch unless the gate itself changes
    layout.tsx                 root html/body, shared, don't duplicate per feature
    page.tsx                   redirect to whichever feature is "home" today
  lib/
    core/                      shared across every feature, ask before editing
      session.ts                PIN + cookie primitives
      devices.ts                hasAccess() and the remembered-device registry
      idempotency.ts            the write guard, see below
      launchers.ts               Home Screen manifest builder
      ui.tsx                    design primitives (Card, Ico, SuccessNote,
                                 PageHead). Add an icon or a primitive here
                                 when your feature needs one; don't paste the
                                 whole old ui.tsx back in.
    shared/                    used by two or more features (not by every
                                page), e.g. expenses.ts is here because Route
                                Planner's mileage widget calls it too. Check
                                research/feature-inventory.md's "Shared core"
                                section before assuming something is
                                feature-only.
```

**A page maps to `/nb/<feature>` automatically.** `basePath: "/nb"` is set
once, in `next.config.ts`. Every path in your code (matcher, imports,
redirects) is basePath-relative, meaning you write `/expenses`, never
`/nb/expenses`. Next strips the basePath before your code (proxy, route
handlers, `redirect()`) ever sees the pathname; the `/nb` only appears in the
browser's address bar. Confirmed against Next's own docs (`node_modules/next/
dist/docs/.../basePath.md`) and by building and curling this repo.

## The pattern: route handler, idempotency key, no Server Actions

Every write in this repo is a route handler under `api/<feature>/`, never a
Server Action (`"use server"`). This is fixed, not a preference:
`research/capacitor-feasibility.md` proved that Next's static export (which
the eventual native shell needs some form of) hard-stops on any Server
Action, no per-route opt-out. Reads can still be plain `fetch` calls from a
client component to a `GET` route handler.

Every route handler that creates a row requires an `Idempotency-Key` header
(or a `idempotency_key` form field for multipart requests) and refuses to
run its write twice for the same key. This is what lets the offline queue
(m15, later) replay a queued write safely after signal returns.

```ts
// api/<feature>/<verb>/route.ts
import { hasAccess } from "../../../lib/core/devices";
import { idempotencyKey, withIdempotency } from "../../../lib/core/idempotency";
import { doTheWrite } from "../../../lib/shared/<feature>"; // or lib/core, or feature-local

export async function POST(req: Request) {
  if (!(await hasAccess())) {
    return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }
  const key = idempotencyKey(req);
  if (!key) {
    return Response.json({ ok: false, error: "Idempotency-Key header is required." }, { status: 400 });
  }
  const body = await req.json();
  try {
    const { result, replayed } = await withIdempotency(`<feature>:${key}`, () => doTheWrite(body));
    return Response.json({ ok: true, result, replayed });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : "Failed." }, { status: 500 });
  }
}
```

Scope your key with a `<feature>:` prefix (as above) so two features can't
collide on the same raw key by coincidence.

On the client, generate the key **once per logical write attempt** and reuse
it across any retry of that same attempt (a failed fetch, a manual re-tap,
or later, an offline-queue replay). Regenerate it only after that specific
write succeeds. Two patterns used in Expenses:
- A stable per-item id created once when the item enters state (a photo
  card's own id), reused as the key on every retry of filing that item.
- A `useState(() => crypto.randomUUID())` held for the life of one form,
  reset only after a successful submit.

A read-only route (a `GET`, or a POST that classifies/suggests but writes
nothing) takes no idempotency key. Expenses' `classify` route is this shape:
it calls the photo classifier but creates no row, so a repeat call just
costs another model call, nothing to dedupe.

**Idempotency storage, and what still needs doing.** `lib/core/
idempotency.ts` keeps a same-instance in-memory map (always correct,
verifiable with a local stub, no external dependency) and opportunistically
persists to a `nb_idempotency_keys` table in the same Supabase project
`lib/core/devices.ts` already reads, for durability across a cold start.
**That table does not exist yet.** Before this matters in production (before
m15's offline queue depends on cross-instance replay), create it:

```sql
create table if not exists nb_idempotency_keys (
  id text primary key,
  response jsonb not null,
  created_at timestamptz not null default now()
);
```

Until it exists, the guard runs on the memory tier alone: correct within one
warm instance, not across a cold start. This is by design, not hidden, see
the comment at the top of `idempotency.ts`.

## Secrets stay server-side

Every `process.env.*` read for a token lives in a route handler or a
`lib/shared`/`lib/core` module marked `import "server-only";`, never in a
client component (`"use client"`). Copy only the env var names your feature
reads into `.env.example`; never a value. `research/feature-inventory.md`
lists each feature's env vars under its own section.

## Shared-core modules: add to them, don't fork them

If your feature needs a shared module that isn't ported yet (for example
`lib/dal.ts`, which is huge and not split yet, per `research/feature-inventory.md`'s
note that it should become `lib/dal/<feature>.ts` slices during the port),
port only the slice you need into `lib/shared/` or your own feature folder,
named for what it does, and ask before touching a module another feature
already owns. Never paste an entire old shared file back in "just in case."

If two features need the exact same thing (session, devices, the design
primitives, the Google Drive client), it belongs in `lib/core/` or
`lib/shared/`, not duplicated per feature.

## Design

Read `.claude/skills/apple-design/SKILL.md` before writing any UI, it runs
first. Then the agency's own law, which outranks every skill:

- No emojis anywhere; styled SVG icons only (see `lib/core/ui.tsx`'s `Ico`).
  Never a spark/sparkle/star icon.
- No monospace typeface anywhere.
- No em dashes in any copy, anywhere, including code comments (run
  `python3 jobhunt/scripts/style_check.py <your files>` before committing;
  it fails the build on a U+2014).
- No explanatory subtext captioning how to use a screen. A subtitle under a
  heading is five words or fewer. Headings are short noun phrases.
- Never the word "ship"/"shipping".
- A confirm button ends in an inline `SuccessNote` for about a second, then
  the row leaves the list (already the pattern in `ExpensesClient.tsx`).
- A missing field renders absent, never "unknown".

**System font stack, not a webfont.** This app is Juan's daily field tool on
a phone: fast, feels installed, no layout shift while a display face
streams in. `globals.css` sets the system stack once; don't add
`next/font` or a display serif. Use the existing color tokens (`#14201B`
near-black, `#FAF9F5` off-white, `#E2DFD5` border, `#8A928C` muted text,
`#2C6A46` success, `#8A2E2E` error, `#8A6D2F` warning) from
`lib/core/ui.tsx` and `ExpensesClient.tsx`'s local button/input classes;
don't invent a new palette.

**Touch and motion.** Buttons respond on press (`active:scale-[0.97]` plus
`transition-transform`, not a fixed-duration animation on release), touch
targets are at least 44px, safe-area insets are respected in any fixed
chrome (`(app)/layout.tsx`'s mobile nav bar shows the pattern:
`[padding-bottom:env(safe-area-inset-bottom)]`).

## Verify locally

```
pnpm install
NB_PIN=1234 NB_SESSION_SECRET=test-secret pnpm exec next build
NB_PIN=1234 NB_SESSION_SECRET=test-secret pnpm exec next start -p 3411
curl -sI http://localhost:3411/nb/<your-feature>      # expect a 307 to /nb/gate
curl -s -c cookies.txt -X POST http://localhost:3411/nb/api/auth \
  -H "content-type: application/json" -d '{"pin":"1234","remember":false}'
curl -s -b cookies.txt -X POST http://localhost:3411/nb/api/<feature>/<verb> \
  -H "Idempotency-Key: k1" -d '...'                    # first call: files
curl -s -b cookies.txt -X POST http://localhost:3411/nb/api/<feature>/<verb> \
  -H "Idempotency-Key: k1" -d '...'                    # second call: { "replayed": true }, no second row
```

If your write needs a real external credential you don't have locally
(HubSpot, Google, a Mac-side bridge), that's fine for `next build` and for
the idempotency guard itself, which is backend-agnostic: verify the guard's
memory-tier logic with a standalone stub the way `idempotency.ts`'s own
module comment describes, and say plainly in your handback that the live
write path itself wasn't exercised against production, rather than
skipping the check.

Screenshot your feature at 390px (phone) and 1440px (desktop) with
Playwright before handing back; `.ui-review/<slug>/` in the scratchpad or
repo root.

## Background jobs: queue, lease, minute drain

Anything that can outlive a request (today: Search's search, enrich and land
stages) is a row in a queue table, never work hidden in `after()` alone.
`nb_search_jobs` is the pattern; `supabase/0002_durable_search_jobs.sql` and
`lib/features/search/dal.ts` (DURABLE QUEUE) are the reference.

- **Queue.** The POST route validates, inserts one `pending` row under an
  Idempotency-Key, answers `{ job }`, then starts it with `after()` as the
  fast path. The browser polls `GET ?job=id`, a narrow status select; the
  result is fetched once, when the status says it exists.
- **Claim with a lease.** `nb_claim_search_job()` moves `pending` to
  `running`, sets `lease_until` a little past the route's `maxDuration`, and
  counts an attempt. Only one runner can win a claim.
- **A dead function is noticed, not waited out.** `nb_sweep_search_jobs()`
  puts a row whose lease lapsed back to `pending` while attempts remain, and
  fails it in place with a plain sentence when they are spent. A passing
  failure (network, a 5xx) is put back by the worker itself; a real error
  fails on the first try. Search and enrich get two tries; a land that writes
  gets one, since a second try after a half-done write would misreport.
- **Minute drain, zero idle egress.** pg_cron runs `nb_search_jobs_tick()`
  every minute inside Postgres. With nothing ready it reads nothing over the
  network and calls nothing. With something ready it POSTs
  `/nb/api/jobs/drain` (shared secret in `nb_job_runner`), which starts up to
  three jobs on Vercel. A job survives a closed tab and a killed function.
- **Visible.** The status poll returns `attempts`; the screen shows Queued,
  Starting, the running line, Retrying, and the second try, and a failed run
  shows its error where the result would have been. Polls back off (1.5s,
  then 4s after a minute, 10s after five).
- **Bounded.** Finished rows are pruned after three days (worker.ts);
  `cron.job_run_details` for `nb-*` jobs is pruned to two days by the
  `nb-cron-log-prune` cron job; pg_net expires its own responses.
- **Safe before the migration.** Every queue function checks once per
  instance whether the durable columns exist and falls back to the original
  lease-less behavior if not.

A new long job copies this: its own `<feature>_jobs` table with the same
columns, its own claim and sweep functions, and a line in the tick. Keep the
fingerprint in SQL: the tick decides inside Postgres whether to call out.

**Retire the Mac worker.** `com.agency.nutribiotic-search-worker`
(`bridges/nutribiotic/search_worker.py`) still polls `nb_search_jobs` every
2 to 10 seconds and often wins the claim, running the Python pipeline instead
of this one, without a lease. It is compatible (a lease-less row gets 20
minutes before the sweep acts), but it is a constant read against the egress
cap and is no longer needed once the drain is live.

**Scripts reviewed, left by hand on purpose.** `scripts/draft-from-visits.ts`
is a backfill of what visit filing already does inline.
`scripts/sync_search_config.mjs` regenerates `config.generated.ts` from the
agency's territory and price files; run it when those change, not on a timer.

## Feature flags: rep-flags.ts is the default, nb_flags is the switch

`lib/core/rep-flags.ts` lists every per-rep switch and who has it by default.
`nb_flags` (`supabase/0003_rep_flags.sql`: flag, rep, value) overrides that
per rep, or for every rep with rep `*`; a rep's own row beats `*`. No row,
or no table, and the app behaves exactly as the file says.

- Server: `myFlag(name)` (`lib/core/user.ts`), through `lib/core/flags.ts`,
  which reads the table at most once a minute per instance and keeps its last
  good answer if a read fails.
- Client: `useFlag(name)` (`lib/core/me.ts`), from the `flags` list
  `/api/me` returns.
- Flip one without a deploy (takes effect within a minute):

```
node scripts/flag.mjs list
node scripts/flag.mjs set <flag> <rep|*> on|off [note]
node scripts/flag.mjs clear <flag> <rep|*>      # back to rep-flags.ts
```

Or edit the row in the Supabase table editor.

**How a risky change lands behind a flag.** Add its line to `REP_FLAGS`
with `on: []`, so it is off for everyone. Guard the new path with
`useFlag("<name>")` or `await myFlag("<name>")` and keep the old path as the
else branch. Deploy, then `flag.mjs set <name> juan on`, try it in the field,
then `set <name> * on` or add the rep to `on`. Once it has been on for both
reps for a while, delete the line, the row, and the old branch together.

## Commit and push

This repo (`github.com/OsmoticVentures/field-sales-os`) is a separate GitHub
remote from the agency monorepo. Commit and push here first, then update the
submodule pointer in the agency repo (`git add osmotic-ventures/field-sales-os`
at the agency root) and push that too.

## basePath and fetch: use `apiFetch`, never a bare `fetch("/api/...")`

The app runs under `basePath: "/nb"`. Next prefixes page routes and `<Link>`
for you; it does not prefix a plain `fetch("/api/...")`, which therefore 404s.
Every client-side call goes through `src/lib/core/api.ts`:

```ts
import { apiFetch } from "@/lib/core/api";
const res = await apiFetch("/api/visit/log", { method: "POST", headers, body });
```

Same for any `<img src>`, `<a href>` you build by hand, or a Scriptable/widget
URL: build it with `apiPath()` from the same module.

## Staging

Staging is a second, always-on copy of ClientOS that runs the same code
against its own Supabase project full of fake accounts. Two reps use
production every day, so anything risky (a migration, a rework of a write
path, a new screen) runs on staging first.

**Branch flow.** Push risky work to the `staging` git branch. Vercel builds
it as a Preview with a stable alias,
`https://field-sales-os-git-staging-juanarenasrec-4192s-projects.vercel.app/nb`.
Sign in there with a staging PIN, try the change, and check
`/nb/api/health` reads `"stage":"staging"`. When it holds up, merge to
`main`; production deploys from `main` as before.

`lib/core/stage.ts` decides which deployment a process is:
`NB_STAGE=staging` wins, then `VERCEL_ENV=production` is production, a
Preview built from branch `staging` is staging, any other Preview is
preview, and everything else (`next dev`, `next start`) is local. A staging
tab reads "Staging" in front of its title.

**Safety rails.**

1. HubSpot is hard off on staging and on every preview.
   `writeEnabled()` and `request()` in `lib/features/visit/hubspot.ts` ask
   `hubspotWritesAllowedHere()` first, so no env flag can turn a push on
   there; the refusal says which deployment refused. Production and local
   keep their flag-driven behavior. `tests/stage.test.mts` covers it.
2. Staging refuses to start against the production database.
   `src/instrumentation.ts` runs once per server instance; if the stage is
   staging and `NB_SUPABASE_URL` names the production project
   (`giodrtaddvmkgvmzomxv`), it throws and every request answers 500. The
   build still goes green, so a dead staging deploy shows as 500s, not as
   a failed build. It never throws in production, preview or local.

The env script adds two smaller ones: staging gets its own session secret
(a production cookie never opens it) and Expenses' Google credentials are
set to a value Google rejects (a staging expense never lands in the real
Drive folder or sheet). Other preview branches still read the production
database through the all-branch Preview env; HubSpot is off there, but
treat their database writes as real.

**Bootstrap a new staging project, end to end.** From the agency root,
once a staging Supabase project exists:

```
# 1. Look at the plan first. Offline, touches nothing.
node osmotic-ventures/field-sales-os/scripts/staging/bootstrap.mjs --ref <staging-ref> --dry-run

# 2. Apply every migration and seed the fake data. The management token
#    comes from SUPABASE_ACCESS_TOKEN in nutribiotic/.env (or
#    STAGING_SUPABASE_ACCESS_TOKEN). Pick two staging PINs, not the
#    production ones. Rerunning skips what is already applied.
STAGING_PIN_JUAN=<pin> STAGING_PIN_KYLE=<other pin> \
  node osmotic-ventures/field-sales-os/scripts/staging/bootstrap.mjs --ref <staging-ref>

# 3. Point branch `staging` at it (Preview vars scoped to that branch only).
python3 osmotic-ventures/field-sales-os/scripts/staging/vercel_staging_env.py --ref <staging-ref> --scope juanarenasrec-4192s-projects

# 4. Create and push the branch, then check health on the alias.
git -C osmotic-ventures/field-sales-os push origin main:staging
curl -s https://field-sales-os-git-staging-juanarenasrec-4192s-projects.vercel.app/nb/api/health
```

The bootstrap refuses the production ref, runs each migration together
with the row that records it in `staging_migrations`, and stops on the
first failure with the file name. Step 3 runs on a machine whose `vercel`
CLI can see Juan's personal team, the same as `scripts/vercel_env_sync.py`.
If Vercel's deployment protection covers previews, the curl in step 4
answers with Vercel's login; open the URL in a browser signed in to Vercel
instead.

**Anonymization rule.** Staging never holds a real customer row, name,
phone or address. The seed is two reps (`juan`, `kyle`, with their real
HubSpot owner ids so the book scoping works) and 30 accounts named
"Staging Market 01" onward, at jittered city-center coordinates, with
555-01xx phone numbers and no HubSpot company id. Every seeded row is
origin `synthetic` under dataset `staging-seed-v1`, so deleting that one
`nb_synthetic_datasets` row purges them all. A migration that inserts a
literal row into any table other than settings and labels stops the
bootstrap until someone reviews it and adds a neutralizer; 0029's
home-base row (a real street address) is replaced by a synthetic waypoint.
Never copy production rows into staging to make a test feel real.

**Current blocker.** There is no staging Supabase project yet. Juan's
Supabase account already has its two free active projects (nutribiotic,
stoke-club), so a third free one cannot be created there. The options: a
separate Supabase account for Osmotic Ventures, which gets its own two free
projects, or pausing one of the two existing projects. Everything above is
ready to run the moment a project ref exists.

## Errors and fixes

Every failure worth fixing becomes one row per distinct error in
`nb_app_errors` (migration `0097_app_errors.sql` in the agency repo), and a
scheduled triage on Juan's Mac turns a new or rising one into a proposed fix
he approves by merging a PR. Nothing reaches `main` without that merge.

**Capture (this repo).**
- `src/instrumentation.ts`: `onRequestError` records anything a route
  handler, server render or the proxy threw and did not catch. `register()`
  starts `lib/core/upstream-watch.ts`, which watches Node's fetch on
  `node:diagnostics_channel` and records any Supabase, HubSpot, Anthropic or
  Google call that answers 400/401/403/429/5xx or never answers. No dal
  needs to remember to report.
- Caught failures: a route handler's catch that answers 500 calls
  `captureError(err, "/api/<feature>/<verb>")` from `lib/core/errors.ts` as
  its first line. **A new route does the same.** A library failure with no
  route uses `"lib/<feature>/<module>"`.
- The phone: `src/instrumentation-client.ts` (window errors, unhandled
  rejections) and the boundaries `src/app/(app)/error.tsx` and
  `src/app/global-error.tsx` post to `/api/errors/report` through
  `lib/core/client-errors.ts`. Signed-in only.
- Fingerprint = kind + normalized message + top app frame + route
  (`lib/core/error-fingerprint.ts`, tested in `tests/error-capture.test.mts`).
  Ids, numbers, quoted values, build hashes and line numbers fold, so one bug
  stays one row across deploys.
- Rows carry count, first and last seen, the rep's `nb_users` id (never the
  PIN), a clipped sample stack and `VERCEL_GIT_COMMIT_SHA`.

**Bounds.** The table grows with distinct errors, not traffic: the RPC
upserts by fingerprint, evicts the oldest past 500 rows, and the triage
prunes anything quiet for 30 days once a day. Each server instance writes a
fingerprint at most every 10 seconds (held hits ride the next write) and 60
rows a minute in all; each page load reports the same message at most once a
minute and 10 times in all. Reporting never throws and never delays a
response (`after()`).

**Why not Sentry's free tier.** A new vendor would hold stacks and request
context from a third party's customer book, add a DSN and an SDK to the
phone bundle, and the triage would still need a second API to read it back.
The table lives in the project the agency already meters, and an idle
triage run reads about 200 bytes.

**Triage (agency repo, `bridges/clientos/errors_triage.py`).** launchd every
15 minutes (`com.agency.clientos-errors-triage.plist`). Fingerprint gate
first; on a new error, or one whose count doubled and grew by 5 since it was
last looked at, it cuts `fix/error-<fingerprint>` from `origin/main` in a
throwaway worktree, lets a headless Claude (subscription, fail-closed
`fix-policy.json`, no git or network) make the smallest fix, then runs
build, test and a no-new-lint-errors gate itself, retrying the agent once on
a failure. Only a green change is committed (as Juan, so Vercel builds the
preview), pushed to the fix branch, opened as a PR, and texted to Juan as
one plain sentence with the PR link. Merge is approval; close is rejection.
At most 3 proposals a day; the log `bridges/clientos/errors-triage.jsonl`
keeps its newest 300 lines.

**Trust check.** `GET /nb/api/errors/selftest` answers 404 unless
`NB_ERRORS_SELFTEST=1` (local or preview only). With it on, no `n` throws a
real TypeError and `?upstream=1` makes one Supabase call with a wrong key.
Then `python3 bridges/clientos/errors_triage.py --only <fingerprint>
--no-text` runs the triage by hand.
