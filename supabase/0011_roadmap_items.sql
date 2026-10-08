-- ---------------------------------------------------------------------------
-- 0011 · roadmap items (2026-10-08). Additive only, idempotent.
--
-- The Marketing screen (/nb/marketing) holds two roadmaps on one page, the
-- marketing roadmap and the sales strategy roadmap. They moved here from a
-- claude.ai artifact whose database kept each project as one JSON document,
-- and this table keeps that shape: one row per project, the whole project in
-- `data` (title, link, priority, pos, placed, budget, stages). The screen's
-- code reads and writes the document as a unit, so a column per field would
-- only add a mapping layer.
--
-- board is the roadmap: 'projects' (marketing) or 'sales' (sales strategy),
-- the collection names the artifact used, kept so its ids carry over.
--
-- BOUND (root P9, "bound every append"): 60 projects per board. The insert
-- trigger refuses the 61st, so the API's own check is not the only one.
-- Reads are one board per request and only on load or after a write; there
-- is no polling loop.
-- ---------------------------------------------------------------------------

create table if not exists public.nb_roadmap_items (
  board      text        not null check (board in ('projects', 'sales')),
  id         text        not null check (length(id) between 1 and 80),
  data       jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (board, id)
);

alter table public.nb_roadmap_items enable row level security;
-- No policies: only the service role (the ClientOS server) reads or writes.

create or replace function public.nb_roadmap_items_bound()
returns trigger language plpgsql set search_path = public as $$
begin
  if (select count(*) from public.nb_roadmap_items where board = new.board) >= 60 then
    raise exception 'The % roadmap holds 60 projects.', new.board using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists nb_roadmap_items_bound on public.nb_roadmap_items;
create trigger nb_roadmap_items_bound before insert on public.nb_roadmap_items
  for each row execute function public.nb_roadmap_items_bound();
