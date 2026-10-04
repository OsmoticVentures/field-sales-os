-- Chains and categories Juan has excluded in Search, shared across devices.
-- Bound: capped at 60 rows per kind by the exclusions route (oldest pruned on write).
create table if not exists nb_search_exclusions (
  kind text not null check (kind in ('chain','category')),
  norm text not null,
  value text not null,
  last_used timestamptz not null default now(),
  primary key (kind, norm)
);
alter table nb_search_exclusions enable row level security;

-- Businesses hidden from Search for good (the big X on a result).
create table if not exists nb_search_hidden (
  places_id text primary key,
  name text,
  hidden_at timestamptz not null default now()
);
alter table nb_search_hidden enable row level security;

-- Named groups of businesses picked from Search, with what Search knew when added.
create table if not exists nb_search_groups (
  id text primary key,
  name text not null unique,
  created_at timestamptz not null default now()
);
alter table nb_search_groups enable row level security;

create table if not exists nb_search_group_members (
  group_id text not null references nb_search_groups(id) on delete cascade,
  places_id text not null,
  name text,
  candidate jsonb not null,
  added_at timestamptz not null default now(),
  primary key (group_id, places_id)
);
alter table nb_search_group_members enable row level security;

insert into nb_search_groups (id, name) values
  ('palm-springs-nutrition', 'Palm Springs Nutrition'),
  ('beverly-hills-beauty', 'Beverly Hills Beauty')
on conflict do nothing;
