-- PIN lockout, shared by every serverless instance.
--
-- The counter used to live in one instance's memory (src/lib/core/session.ts),
-- so a cold start or a second instance handed out a fresh five attempts. It
-- now lives here, one row per key: `ip:<hash>` for each address that failed,
-- and `global` as a ceiling across all addresses.
--
-- Bound: a row older than one day is pruned on every write, and the table is
-- capped at 500 rows (oldest first). A raw address is never stored, only a
-- SHA-256 prefix of it.
--
-- The functions run as the caller (security invoker), the table has RLS on and
-- no policy, and only service_role may execute them, so the anon key can
-- neither read nor reset a lock.

create table if not exists public.nb_pin_attempts (
  key text primary key,
  failures integer not null default 0,
  window_start timestamptz not null default now(),
  locked_until timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.nb_pin_attempts enable row level security;

-- Seconds left on the longest lock among the given keys (0 when none).
create or replace function public.nb_pin_lock_remaining(p_keys text[])
returns integer
language sql
stable
set search_path = ''
as $$
  select coalesce(max(ceil(extract(epoch from (locked_until - now()))))::int, 0)
  from public.nb_pin_attempts
  where key = any(p_keys) and locked_until > now();
$$;

-- Count one failure against a key. Failures older than the window start over.
-- Returns the attempts left before a lock and the lock's seconds remaining.
create or replace function public.nb_pin_fail(p_key text, p_max integer, p_minutes integer)
returns table (attempts_left integer, locked_seconds integer)
language plpgsql
set search_path = ''
as $$
declare
  r public.nb_pin_attempts;
begin
  insert into public.nb_pin_attempts as a (key, failures, window_start, updated_at)
  values (p_key, 1, now(), now())
  on conflict (key) do update set
    failures = case when a.window_start < now() - make_interval(mins => p_minutes)
                      or (a.locked_until is not null and a.locked_until <= now())
                    then 1 else a.failures + 1 end,
    window_start = case when a.window_start < now() - make_interval(mins => p_minutes)
                          or (a.locked_until is not null and a.locked_until <= now())
                        then now() else a.window_start end,
    locked_until = case when a.locked_until <= now() then null else a.locked_until end,
    updated_at = now()
  returning * into r;

  if r.failures >= p_max then
    update public.nb_pin_attempts
       set locked_until = now() + make_interval(mins => p_minutes), failures = 0, window_start = now()
     where key = p_key
     returning * into r;
  end if;

  -- The bound: a day of history, at most 500 rows.
  delete from public.nb_pin_attempts where updated_at < now() - interval '1 day';
  delete from public.nb_pin_attempts where key in (
    select key from public.nb_pin_attempts order by updated_at desc offset 500);

  attempts_left := case when r.locked_until is not null then 0 else greatest(p_max - r.failures, 0) end;
  locked_seconds := coalesce(ceil(extract(epoch from (r.locked_until - now())))::int, 0);
  return next;
end;
$$;

-- A correct PIN clears that address's count (the global ceiling keeps its own).
create or replace function public.nb_pin_success(p_key text)
returns void
language sql
set search_path = ''
as $$
  update public.nb_pin_attempts
     set failures = 0, locked_until = null, window_start = now(), updated_at = now()
   where key = p_key;
$$;

revoke all on function public.nb_pin_lock_remaining(text[]) from public, anon, authenticated;
revoke all on function public.nb_pin_fail(text, integer, integer) from public, anon, authenticated;
revoke all on function public.nb_pin_success(text) from public, anon, authenticated;
grant execute on function public.nb_pin_lock_remaining(text[]) to service_role;
grant execute on function public.nb_pin_fail(text, integer, integer) to service_role;
grant execute on function public.nb_pin_success(text) to service_role;
