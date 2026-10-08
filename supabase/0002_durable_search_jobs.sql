-- Durable Search jobs (2026-10-08). Additive only.
--
-- Before this, a search ran inside the request that queued it (after()), and a
-- function that died mid-run left the row "running" until a poll noticed 20
-- minutes later. Now:
--   * a claim takes a lease (lease_until) and counts an attempt;
--   * a lapsed lease means the function died: the row goes back to pending
--     while attempts remain, and fails in place with a plain sentence when
--     they are spent;
--   * pg_cron ticks every minute IN THE DATABASE. When nothing is pending
--     the tick reads nothing over the network and calls nothing (zero
--     egress). Only when a row is ready does it POST /nb/api/jobs/drain,
--     which runs it on Vercel. So a job survives a closed tab and a dead
--     function, and a poll from an open tab still starts it within seconds.
--
-- Bounds: cron.job_run_details (one row per tick) is pruned to two days by a
-- second cron job below; pg_net's own response table expires on its own
-- (6 hours by default); nb_search_jobs keeps its existing 3-day prune
-- (worker.ts pruneSearchJobs).

create extension if not exists pg_cron;
create extension if not exists pg_net;

alter table public.nb_search_jobs
  add column if not exists attempts int not null default 0,
  add column if not exists max_attempts int not null default 2,
  add column if not exists lease_until timestamptz;

-- Where the tick sends ready work, and the shared secret the drain route
-- checks. One row. RLS on with no policy: only the service role reads it.
create table if not exists public.nb_job_runner (
  id int primary key default 1 check (id = 1),
  drain_url text not null,
  secret text not null default encode(extensions.gen_random_bytes(24), 'hex'),
  updated_at timestamptz not null default now()
);
alter table public.nb_job_runner enable row level security;
insert into public.nb_job_runner (id, drain_url)
values (1, 'https://osmoticventures.com/nb/api/jobs/drain')
on conflict (id) do nothing;

-- Take one pending job: running, a lease, one more attempt. Null when another
-- runner already has it or its attempts are spent.
create or replace function public.nb_claim_search_job(p_id text, p_lease_seconds int default 330)
returns table (id text, stage text, params jsonb, attempts int, max_attempts int)
language sql
security definer
set search_path = public
as $$
  update public.nb_search_jobs j
     set status = 'running',
         started_at = now(),
         lease_until = now() + make_interval(secs => p_lease_seconds),
         attempts = j.attempts + 1,
         error = null
   where j.id = p_id
     and j.status = 'pending'
     and j.attempts < j.max_attempts
  returning j.id, j.stage, j.params, j.attempts, j.max_attempts;
$$;

-- Recover runs whose function died, then count what is ready to run.
-- A row with no lease (claimed by the old Mac worker) gets 20 minutes.
create or replace function public.nb_sweep_search_jobs()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  ready int;
begin
  update public.nb_search_jobs
     set status = 'pending', lease_until = null
   where status = 'running'
     and coalesce(lease_until, started_at + interval '20 minutes') < now()
     and attempts < max_attempts;

  update public.nb_search_jobs
     set status = 'error',
         lease_until = null,
         error = case when attempts <= 1
           then 'This run stopped before it finished. Nothing was saved from it. Run it again.'
           else 'This run stopped ' || attempts || ' times before it finished. Nothing was saved from it. Run it again.'
         end
   where status = 'running'
     and coalesce(lease_until, started_at + interval '20 minutes') < now()
     and attempts >= max_attempts;

  -- A pending row whose attempts are spent can only come from a hand edit;
  -- fail it rather than leave it queued forever.
  update public.nb_search_jobs
     set status = 'error', error = 'This run could not be started. Run it again.'
   where status = 'pending' and attempts >= max_attempts;

  select count(*) into ready
    from public.nb_search_jobs
   where status = 'pending' and updated_at < now() - interval '10 seconds';
  return ready;
end;
$$;

-- The minute tick. All reads stay inside Postgres; the only network call is
-- the POST when something is ready.
create or replace function public.nb_search_jobs_tick()
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  ready int;
  r public.nb_job_runner;
begin
  ready := public.nb_sweep_search_jobs();
  if ready = 0 then
    return;
  end if;
  select * into r from public.nb_job_runner where id = 1;
  if r.drain_url is null then
    return;
  end if;
  perform net.http_post(
    url := r.drain_url,
    body := jsonb_build_object('ready', ready),
    headers := jsonb_build_object('content-type', 'application/json', 'x-nb-runner', r.secret),
    timeout_milliseconds := 10000
  );
end;
$$;

-- Only the service role (the app) may call these over PostgREST.
revoke all on function public.nb_claim_search_job(text, int) from public, anon, authenticated;
revoke all on function public.nb_sweep_search_jobs() from public, anon, authenticated;
revoke all on function public.nb_search_jobs_tick() from public, anon, authenticated;
grant execute on function public.nb_claim_search_job(text, int) to service_role;
grant execute on function public.nb_sweep_search_jobs() to service_role;

select cron.schedule('nb-search-jobs-tick', '* * * * *', 'select public.nb_search_jobs_tick()');
select cron.schedule(
  'nb-cron-log-prune',
  '17 4 * * *',
  $$delete from cron.job_run_details
     where end_time < now() - interval '2 days'
       and jobid in (select jobid from cron.job where jobname like 'nb-%')$$
);
