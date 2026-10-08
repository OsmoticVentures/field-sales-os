-- Per-rep switches in the database (2026-10-08). Additive only.
--
-- src/lib/core/rep-flags.ts stays the default: a flag with no row here
-- behaves exactly as that file says. A row overrides it for one rep, or for
-- every rep with rep = '*'. A rep's own row beats the '*' row.
--
--   on for Kyle:      insert into nb_flags (flag, rep, value) values ('my-flag', 'kyle', true)
--                       on conflict (flag, rep) do update set value = excluded.value, updated_at = now();
--   back to default:  delete from nb_flags where flag = 'my-flag' and rep = 'kyle';
--
-- Or: node scripts/flag.mjs set my-flag kyle on
--
-- Bound: one row per (flag, rep), so the table never outgrows the number of
-- flags times the number of reps. The app reads it at most once a minute per
-- server instance (flags.ts), a few hundred bytes.

create table if not exists public.nb_flags (
  flag text not null check (flag ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  rep text not null,
  value boolean not null,
  note text,
  updated_at timestamptz not null default now(),
  primary key (flag, rep)
);
alter table public.nb_flags enable row level security;
