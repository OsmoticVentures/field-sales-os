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
