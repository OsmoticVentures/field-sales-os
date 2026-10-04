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
