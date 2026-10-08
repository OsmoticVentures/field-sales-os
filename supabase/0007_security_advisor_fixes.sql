-- The additive fixes from the Supabase security advisor, 2026-10-08.
--
-- 1. The anon role could SELECT six nb_v_* views. A view runs as its owner, so
--    it skips the row level security on the tables under it: anyone holding
--    the project's anon key could read account stages, product mix and the
--    activity ledger. Nothing in the agency uses the anon key (ClientOS and
--    the bridges use the service role, and Supabase Auth has no users), so
--    taking the grant away changes nothing for them.
-- 2. nb_pin_attempts is reachable by the service role only.
-- 3. Every nb_* function gets a fixed search_path (advisor:
--    function_search_path_mutable), the same path the database already uses,
--    so no function resolves a name differently than it does today.
--
-- Left for Juan, not changed here: the views are still security definer for
-- the authenticated role, and every "authenticated_all" policy is USING (true).
-- Both only matter once Supabase Auth has a user.

do $$
declare v record;
begin
  for v in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind in ('v', 'm') and c.relname like 'nb\_v\_%'
  loop
    execute format('revoke all on public.%I from anon', v.relname);
  end loop;
end $$;

revoke all on public.nb_pin_attempts from anon, authenticated;

do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'nb\_%' and p.proconfig is null
             and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
  loop
    execute format('alter function %s set search_path = public, extensions', f.sig);
  end loop;
end $$;
