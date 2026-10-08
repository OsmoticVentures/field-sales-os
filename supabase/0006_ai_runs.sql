-- ---------------------------------------------------------------------------
-- 0006 · nb_ai_runs (production: agency nutribiotic/supabase/migrations/0098_ai_runs.sql): one row per AI call in ClientOS
-- (osmotic-ventures/field-sales-os, src/lib/core/ai/), for error analysis.
-- Task, model, latency, tokens, whether the reply validated against its
-- schema, a hash of the input, and short excerpts of the input and output.
-- tests/evals/ in that repo reads the recent rows back and prints a failure
-- table per task, offline, with no model calls.
--
-- BOUNDED (root P9, "bound every append"):
--   1. Text is clipped inside nb_ai_run_log: input 1500 chars, output 6000,
--      error 500. A row is a few KB at most.
--   2. A hard row cap of 3000, enforced inside the same call that inserts.
--   3. The nightly prune runs on the first write of each Los Angeles day,
--      inside nb_ai_run_log: anything older than 30 days goes. No pg_cron on
--      this project, and no separate job to forget.
-- The app writes with Prefer: return=minimal and never polls this table, so
-- it costs no egress; the eval script reads at most 500 rows when run by hand.
--
-- The rows hold excerpts of notes about NutriBiotic's customers, which are
-- not ours (nutribiotic/AGENTS.md): service role only, like nb_touchpoints.
-- ---------------------------------------------------------------------------

create table if not exists nb_ai_runs (
  id                 bigserial primary key,
  created_at         timestamptz not null default now(),
  task               text not null,
  model              text not null,
  ok                 boolean not null,
  validation         text not null check (validation in ('pass', 'fail', 'error', 'text')),
  attempts           smallint not null default 1,
  fallback_used      boolean not null default false,
  latency_ms         integer not null default 0,
  input_tokens       integer not null default 0,
  output_tokens      integer not null default 0,
  cache_read_tokens  integer not null default 0,
  cache_write_tokens integer not null default 0,
  stop_reason        text,
  input_hash         text not null default '',
  input_excerpt      text not null default '',
  output_excerpt     text,
  error              text,
  actor              text
);

create index if not exists nb_ai_runs_created_at_idx on nb_ai_runs (created_at);
create index if not exists nb_ai_runs_task_created_idx on nb_ai_runs (task, created_at desc);

alter table nb_ai_runs enable row level security;
revoke all privileges on table nb_ai_runs from anon, authenticated;

-- One run. `p` is the app's RunRecord as JSON (src/lib/core/ai/core.ts).
create or replace function nb_ai_run_log(p jsonb) returns void
language plpgsql as $$
declare
  first_today boolean;
begin
  first_today := not exists (
    select 1 from nb_ai_runs
     where created_at >= (date_trunc('day', now() at time zone 'America/Los_Angeles') at time zone 'America/Los_Angeles'));

  insert into nb_ai_runs (
    task, model, ok, validation, attempts, fallback_used, latency_ms,
    input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
    stop_reason, input_hash, input_excerpt, output_excerpt, error, actor)
  values (
    left(coalesce(p->>'task', ''), 60),
    left(coalesce(p->>'model', ''), 60),
    coalesce((p->>'ok')::boolean, false),
    case when p->>'validation' in ('pass', 'fail', 'error', 'text') then p->>'validation' else 'error' end,
    least(greatest(coalesce((p->>'attempts')::int, 1), 0), 100),
    coalesce((p->>'fallback_used')::boolean, false),
    least(greatest(coalesce((p->>'latency_ms')::bigint, 0), 0), 2000000000),
    least(greatest(coalesce((p->>'input_tokens')::bigint, 0), 0), 2000000000),
    least(greatest(coalesce((p->>'output_tokens')::bigint, 0), 0), 2000000000),
    least(greatest(coalesce((p->>'cache_read_tokens')::bigint, 0), 0), 2000000000),
    least(greatest(coalesce((p->>'cache_write_tokens')::bigint, 0), 0), 2000000000),
    left(p->>'stop_reason', 40),
    left(coalesce(p->>'input_hash', ''), 64),
    left(coalesce(p->>'input_excerpt', ''), 1500),
    left(p->>'output_excerpt', 6000),
    left(p->>'error', 500),
    left(p->>'actor', 40));

  -- Row cap, every call: cheap, one index range.
  delete from nb_ai_runs
   where id <= (select id from nb_ai_runs order by id desc offset 3000 limit 1);

  if first_today then
    perform nb_ai_runs_prune();
  end if;
end $$;

-- Nightly bound: older than 30 days. Returns how many rows went.
create or replace function nb_ai_runs_prune() returns integer
language plpgsql as $$
declare
  n integer;
begin
  delete from nb_ai_runs where created_at < now() - interval '30 days';
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function nb_ai_run_log(jsonb) from public, anon, authenticated;
revoke all on function nb_ai_runs_prune() from public, anon, authenticated;
grant execute on function nb_ai_run_log(jsonb) to service_role;
grant execute on function nb_ai_runs_prune() to service_role;
