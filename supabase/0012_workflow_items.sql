-- ---------------------------------------------------------------------------
-- 0012 · workflow items (2026-10-08). Additive only, idempotent.
--
-- The Workflow screen (/nb/workflow) holds workflow maps and folder trees.
-- Each is one JSON document the screen reads and writes whole, the same
-- shape as nb_roadmap_items (0011): a map is its title, phases and steps;
-- a folder tree is its title and nested folders.
--
-- board is the kind: 'maps' or 'folders'.
--
-- BOUND (root P9, "bound every append"): 20 documents per board and 60 KB
-- per document. The insert trigger refuses the 21st, so the API's own check
-- is not the only one. Reads are one board per request and only on load or
-- after a write; there is no polling loop.
-- ---------------------------------------------------------------------------

create table if not exists public.nb_workflow_items (
  board      text        not null check (board in ('maps', 'folders')),
  id         text        not null check (length(id) between 1 and 80),
  data       jsonb       not null default '{}'::jsonb check (pg_column_size(data) <= 60000),
  updated_at timestamptz not null default now(),
  primary key (board, id)
);

alter table public.nb_workflow_items enable row level security;
-- No policies: only the service role (the ClientOS server) reads or writes.

create or replace function public.nb_workflow_items_bound()
returns trigger language plpgsql set search_path = public as $$
begin
  if (select count(*) from public.nb_workflow_items where board = new.board) >= 20 then
    raise exception 'The % board holds 20 documents.', new.board using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists nb_workflow_items_bound on public.nb_workflow_items;
create trigger nb_workflow_items_bound before insert on public.nb_workflow_items
  for each row execute function public.nb_workflow_items_bound();
