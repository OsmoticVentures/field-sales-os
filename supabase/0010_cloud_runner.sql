-- ---------------------------------------------------------------------------
-- 0010 · the cloud runner (2026-10-08). Additive only, idempotent.
--
-- The HubSpot sync and the other Mac-free NutriBiotic jobs moved off Juan's
-- Mac to a scheduled GitHub Actions workflow in the private agency repo
-- (.github/workflows/nutribiotic-cloud.yml, runner bridges/nutribiotic/cloud/).
-- The Python is the same; only the host changed. Two things the Mac gave for
-- free have to live in the database now:
--
--   1. ONE WRITER AT A TIME. HubSpot portal 148711228 is shared with another
--      rep and HQ (nutribiotic/AGENTS.md HARD RULE 2). The Mac plists are kept
--      so they can be reloaded, which means a reload while the cloud runs would
--      put two sync writers on the portal. nb_runner_leases holds one row per
--      job; a run writes only while it holds the lease, from the Mac or the
--      cloud alike. A lease that is not renewed lapses on its own, so a runner
--      that dies never blocks the next one for longer than its lease.
--
--   2. THE EGRESS METER (root P9). A runner's filesystem is gone when the job
--      ends, so the egress-YYYY-MM.log the Mac appends to cannot hold the
--      cloud's bytes. nb_cloud_meter keeps one row per (LA day, process),
--      incremented by nb_cloud_meter_add at the end of each run, and
--      bridges/supabase_guard.py reads it beside the Mac's file.
--
-- BOUNDS (root P9, "bound every append"): nb_runner_leases is one row per job
-- name, upserted. nb_cloud_meter is one row per day per process, and
-- nb_cloud_meter_add deletes rows older than 62 days in the same call that
-- writes, so no separate prune job exists to be forgotten.
--
-- No pg_cron schedule is created here: the scheduler is GitHub Actions. The
-- runner reads NB_SUPABASE_URL and NB_SUPABASE_SERVICE_ROLE_KEY from the
-- repo's Actions secrets, so moving projects is one secret swap
-- (bridges/nutribiotic/cloud/set_secrets.sh) plus replaying this file.
--
-- Service role only. Lease holders and meter rows carry no customer data.
-- ---------------------------------------------------------------------------

create table if not exists public.nb_runner_leases (
  name        text primary key,
  holder      text not null,
  lease_until timestamptz not null,
  taken_at    timestamptz not null default now()
);
alter table public.nb_runner_leases enable row level security;
revoke all privileges on table public.nb_runner_leases from anon, authenticated;

-- Take or renew a lease. True when p_holder now holds `p_name` until
-- now() + p_seconds; false when someone else holds an unexpired one.
create or replace function public.nb_take_lease(p_name text, p_holder text, p_seconds int)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  got text;
begin
  insert into public.nb_runner_leases as l (name, holder, lease_until, taken_at)
  values (p_name, p_holder, now() + make_interval(secs => p_seconds), now())
  on conflict (name) do update
     set holder = excluded.holder,
         lease_until = excluded.lease_until,
         taken_at = case when l.holder = excluded.holder then l.taken_at else now() end
   where l.holder = excluded.holder or l.lease_until < now()
  returning holder into got;
  return got is not null;
end;
$$;

-- Give a lease back early. Only its holder can.
create or replace function public.nb_release_lease(p_name text, p_holder text)
returns void
language sql
security definer
set search_path = public
as $$
  update public.nb_runner_leases
     set lease_until = now()
   where name = p_name and holder = p_holder;
$$;

create table if not exists public.nb_cloud_meter (
  day    date not null,
  proc   text not null,
  bytes  bigint not null default 0,
  calls  integer not null default 0,
  runs   integer not null default 0,
  primary key (day, proc)
);
alter table public.nb_cloud_meter enable row level security;
revoke all privileges on table public.nb_cloud_meter from anon, authenticated;

create or replace function public.nb_cloud_meter_add(p_proc text, p_bytes bigint, p_calls int)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  today date := (now() at time zone 'America/Los_Angeles')::date;
begin
  insert into public.nb_cloud_meter as m (day, proc, bytes, calls, runs)
  values (today, left(p_proc, 80), greatest(p_bytes, 0), greatest(p_calls, 0), 1)
  on conflict (day, proc) do update
     set bytes = m.bytes + excluded.bytes,
         calls = m.calls + excluded.calls,
         runs  = m.runs + 1;
  delete from public.nb_cloud_meter where day < today - 62;
end;
$$;

revoke all on function public.nb_take_lease(text, text, int) from public, anon, authenticated;
revoke all on function public.nb_release_lease(text, text) from public, anon, authenticated;
revoke all on function public.nb_cloud_meter_add(text, bigint, int) from public, anon, authenticated;
grant execute on function public.nb_take_lease(text, text, int) to service_role;
grant execute on function public.nb_release_lease(text, text) to service_role;
grant execute on function public.nb_cloud_meter_add(text, bigint, int) to service_role;
