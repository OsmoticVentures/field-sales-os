-- ---------------------------------------------------------------------------
-- 0009 · the AI spend cap, 2026-10-08. Additive only: one new column, one new
-- table, three functions (one replaced with the same signature).
--
-- 1. nb_ai_runs.cost_usd: what each run cost, priced in the app
--    (src/lib/core/ai/core.ts costUsd, every attempt at the model that
--    answered it, web searches included). nb_ai_run_log stores it.
--
-- 2. nb_ai_spend_days: ONE ROW PER PACIFIC DAY, the whole app's AI spend.
--      spent_usd     real cost of the calls settled today
--      reserved_usd  estimates held by calls still in flight
--    The app never reads this table; it calls the two functions below, each
--    one small RPC. BOUNDED: a row a day, rows older than 90 days go on the
--    first reservation of each new day.
--
-- 3. nb_ai_spend_reserve(p_usd, p_cap): before every API call. ONE
--    conditional UPDATE adds p_usd to reserved_usd only while
--    spent + reserved + p_usd <= p_cap. Under concurrency Postgres takes the
--    row lock and re-evaluates the WHERE against the newest row version for
--    each waiter (READ COMMITTED), so instances on different serverless
--    workers cannot both pass on the same last dollar.
--    A hold older than 3 minutes is dropped (no call lives past 60 s; a hold
--    that old is an instance that died before settling).
--    Refused: blocked += 1, and the first refusal of the day files one row in
--    nb_app_errors (fingerprint aicap-YYYY-MM-DD) for the error triage, which
--    texts Juan. Once per day by construction: alerted_at is set by a
--    conditional UPDATE only one caller can win.
--    p_day is for the live race test only (tests/ai-spend-race.live.mts): it
--    names a past day, and a test day never files an alert.
--
-- 4. nb_ai_spend_settle(p_day, p_reserved, p_actual): after the call, the
--    held estimate comes off and the real cost goes on, on the day it was
--    reserved (a call across midnight settles on its own day).
--
-- Service role only, like nb_ai_runs.
-- ---------------------------------------------------------------------------

alter table nb_ai_runs add column if not exists cost_usd numeric(12,6) not null default 0;

create table if not exists nb_ai_spend_days (
  day           date primary key,
  cap_usd       numeric(10,4) not null,
  spent_usd     numeric(12,6) not null default 0,
  reserved_usd  numeric(12,6) not null default 0,
  calls         integer not null default 0,
  blocked       integer not null default 0,
  alerted_at    timestamptz,
  updated_at    timestamptz not null default now()
);

alter table nb_ai_spend_days enable row level security;
revoke all privileges on table nb_ai_spend_days from anon, authenticated;

create or replace function nb_ai_spend_reserve(p_usd numeric, p_cap numeric, p_day date default null)
returns jsonb
language plpgsql as $$
declare
  d        date := coalesce(p_day, (now() at time zone 'America/Los_Angeles')::date);
  amt      numeric := greatest(coalesce(p_usd, 0), 0);
  new_day  boolean;
  r        nb_ai_spend_days;
  alerted  boolean := false;
begin
  insert into nb_ai_spend_days (day, cap_usd) values (d, p_cap)
  on conflict (day) do nothing
  returning true into new_day;

  if coalesce(new_day, false) and p_day is null then
    delete from nb_ai_spend_days where day < d - 90;
  end if;

  update nb_ai_spend_days s
     set reserved_usd = (case when s.updated_at < now() - interval '3 minutes' then 0 else s.reserved_usd end) + amt,
         cap_usd      = p_cap,
         updated_at   = now()
   where s.day = d
     and s.spent_usd + (case when s.updated_at < now() - interval '3 minutes' then 0 else s.reserved_usd end) + amt <= p_cap
  returning * into r;

  if found then
    return jsonb_build_object('ok', true, 'day', d, 'spent_usd', r.spent_usd, 'reserved_usd', r.reserved_usd);
  end if;

  update nb_ai_spend_days s
     set blocked = s.blocked + 1, cap_usd = p_cap
   where s.day = d
  returning * into r;

  update nb_ai_spend_days s
     set alerted_at = now()
   where s.day = d and s.alerted_at is null
  returning true into alerted;

  if coalesce(alerted, false) and p_day is null then
    perform nb_app_error_hit(
      'aicap-' || to_char(d, 'YYYY-MM-DD'),
      'server',
      '/ai/daily-cap',
      format('Today''s AI limit of $%s was reached at %s Pacific ($%s spent). AI steps in ClientOS are off until midnight Pacific; everything else keeps working.',
             trim(to_char(p_cap, 'FM999990.00')),
             to_char(now() at time zone 'America/Los_Angeles', 'FMHH12:MI AM'),
             trim(to_char(r.spent_usd, 'FM999990.00'))),
      'nb_ai_spend_reserve',
      '',
      null,
      null,
      1);
  end if;

  return jsonb_build_object('ok', false, 'day', d, 'spent_usd', r.spent_usd, 'reserved_usd', r.reserved_usd, 'alerted', coalesce(alerted, false));
end $$;

create or replace function nb_ai_spend_settle(p_day date, p_reserved numeric, p_actual numeric)
returns void
language plpgsql as $$
begin
  update nb_ai_spend_days
     set reserved_usd = greatest(reserved_usd - greatest(coalesce(p_reserved, 0), 0), 0),
         spent_usd    = spent_usd + greatest(coalesce(p_actual, 0), 0),
         calls        = calls + 1,
         updated_at   = now()
   where day = p_day;
end $$;

-- nb_ai_run_log, as in 0006, plus cost_usd.
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
    input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd,
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
    least(greatest(coalesce((p->>'cost_usd')::numeric, 0), 0), 999999),
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

revoke all on function nb_ai_spend_reserve(numeric, numeric, date) from public, anon, authenticated;
revoke all on function nb_ai_spend_settle(date, numeric, numeric) from public, anon, authenticated;
revoke all on function nb_ai_run_log(jsonb) from public, anon, authenticated;
grant execute on function nb_ai_spend_reserve(numeric, numeric, date) to service_role;
grant execute on function nb_ai_spend_settle(date, numeric, numeric) to service_role;
grant execute on function nb_ai_run_log(jsonb) to service_role;
