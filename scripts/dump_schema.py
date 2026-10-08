#!/usr/bin/env python3
"""Write the live ClientOS schema (every nb_* table, view, type, function,
trigger and policy in `public`) as one SQL file, read straight from the
production catalog through the Supabase management API. Read-only: it runs
SELECTs against pg_catalog and nothing else.

  python3 scripts/dump_schema.py                 # print to stdout
  python3 scripts/dump_schema.py --out FILE      # write FILE
  python3 scripts/dump_schema.py --check FILE    # exit 1 if production drifted from FILE

Token: SUPABASE_ACCESS_TOKEN in the environment, else the agency's
nutribiotic/.env. Project: NB_SUPABASE_PROJECT_REF, else giodrtaddvmkgvmzomxv.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.request
from pathlib import Path

REF = os.environ.get("NB_SUPABASE_PROJECT_REF", "giodrtaddvmkgvmzomxv")
PREFIX = "nb\\_%"


def token() -> str:
    tok = os.environ.get("SUPABASE_ACCESS_TOKEN")
    if tok:
        return tok
    env = Path(__file__).resolve().parents[3] / "nutribiotic" / ".env"
    for line in env.read_text().splitlines():
        if line.startswith("SUPABASE_ACCESS_TOKEN="):
            return line.split("=", 1)[1].strip().strip("\"'")
    sys.exit("SUPABASE_ACCESS_TOKEN not set")


def q(sql: str) -> list[dict]:
    req = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{REF}/database/query",
        data=json.dumps({"query": sql}).encode(),
        method="POST",
        headers={"Authorization": f"Bearer {token()}", "Content-Type": "application/json",
                 "User-Agent": "curl/8.7.1"})
    out = json.loads(urllib.request.urlopen(req, timeout=120).read().decode())
    if isinstance(out, dict):
        sys.exit(f"query failed: {out.get('message')}")
    return out


def ident(name: str) -> str:
    return name if name.replace("_", "a").isalnum() and name == name.lower() and not name[0].isdigit() else '"' + name.replace('"', '""') + '"'


def lit(s: str) -> str:
    return "'" + s.replace("'", "''") + "'"


def build() -> str:
    out: list[str] = [
        "-- ClientOS baseline: the production schema of every nb_* object in public,",
        f"-- read from project {REF} by scripts/dump_schema.py. Idempotent: every",
        "-- statement is IF NOT EXISTS or OR REPLACE, so it runs clean on production.",
        "-- Regenerate with `python3 scripts/dump_schema.py --out <file>`; check drift",
        "-- with `--check`. Grants are left at Supabase's defaults and not captured;",
        "-- a migration that narrows one (revoke/grant) states it itself.",
        "",
        "set check_function_bodies = off;",
        "",
        "create extension if not exists postgis with schema public;",
        "create extension if not exists pgcrypto with schema extensions;",
        'create extension if not exists "uuid-ossp" with schema extensions;',
        "create extension if not exists pg_stat_statements with schema extensions;",
        "",
    ]

    # Types (enum, domain, composite) named nb_*.
    for t in q(f"""
        select t.typname, t.typtype,
               (select json_agg(e.enumlabel order by e.enumsortorder) from pg_enum e where e.enumtypid=t.oid) labels,
               format_type(t.typbasetype, t.typtypmod) base
        from pg_type t join pg_namespace n on n.oid=t.typnamespace
        where n.nspname='public' and t.typname like '{PREFIX}' and t.typtype in ('e','d')
        order by 1"""):
        if t["typtype"] == "e":
            labels = ", ".join(lit(x) for x in t["labels"])
            body = f"create type public.{ident(t['typname'])} as enum ({labels});"
        else:
            body = f"create domain public.{ident(t['typname'])} as {t['base']};"
        out.append(f"do $$ begin {body} exception when duplicate_object then null; end $$;")
    out.append("")

    # Sequences owned by nb_* tables.
    seqs = q(f"""
        select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='public' and c.relkind='S' and c.relname like '{PREFIX}'
          and not exists (select 1 from pg_depend d where d.objid=c.oid and d.deptype='i')
        order by 1""")
    for s in seqs:
        out.append(f"create sequence if not exists public.{ident(s['relname'])};")
    out.append("")

    # Tables: columns, then constraints (FKs deferred to after every table).
    tables = q(f"""
        select c.oid::int oid, c.relname, c.relrowsecurity rls, c.relforcerowsecurity force_rls,
               obj_description(c.oid,'pg_class') comment
        from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='public' and c.relkind in ('r','p') and c.relname like '{PREFIX}' order by 2""")
    cols = q(f"""
        select a.attrelid::int oid, a.attname, format_type(a.atttypid, a.atttypmod) typ, a.attnotnull nn,
               pg_get_expr(d.adbin, d.adrelid) def, a.attidentity ident, a.attgenerated gen,
               col_description(a.attrelid, a.attnum) comment
        from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
        left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
        where n.nspname='public' and c.relkind in ('r','p') and c.relname like '{PREFIX}'
          and a.attnum>0 and not a.attisdropped order by a.attrelid, a.attnum""")
    cons = q(f"""
        select c.conrelid::int oid, c.conname, c.contype, pg_get_constraintdef(c.oid) def
        from pg_constraint c join pg_class r on r.oid=c.conrelid join pg_namespace n on n.oid=r.relnamespace
        where n.nspname='public' and r.relname like '{PREFIX}' and c.contype in ('p','u','c','f','x')
        order by c.conrelid, case c.contype when 'p' then 0 when 'u' then 1 when 'c' then 2 when 'x' then 3 else 4 end, c.conname""")
    fks: list[str] = []
    comments: list[str] = []
    for t in tables:
        name = f"public.{ident(t['relname'])}"
        lines = []
        for c in (c for c in cols if c["oid"] == t["oid"]):
            col = f"  {ident(c['attname'])} {c['typ']}"
            if c["gen"] == "s":
                col += f" generated always as ({c['def']}) stored"
            elif c["ident"] in ("a", "d"):
                col += " generated " + ("always" if c["ident"] == "a" else "by default") + " as identity"
            elif c["def"] is not None:
                col += f" default {c['def']}"
            if c["nn"]:
                col += " not null"
            lines.append(col)
            if c["comment"]:
                comments.append(f"comment on column {name}.{ident(c['attname'])} is {lit(c['comment'])};")
        for k in (k for k in cons if k["oid"] == t["oid"]):
            stmt = f"constraint {ident(k['conname'])} {k['def']}"
            if k["contype"] == "f":
                fks.append(
                    f"do $$ begin alter table {name} add {stmt}; "
                    "exception when duplicate_object or duplicate_table then null; end $$;")
            else:
                lines.append("  " + stmt)
        out.append(f"create table if not exists {name} (\n" + ",\n".join(lines) + "\n);")
        if t["rls"]:
            out.append(f"alter table {name} enable row level security;")
        if t["force_rls"]:
            out.append(f"alter table {name} force row level security;")
        if t["comment"]:
            comments.append(f"comment on table {name} is {lit(t['comment'])};")
        out.append("")
    out += fks + [""]

    # Sequence ownership, once the owning columns exist.
    for s in q(f"""
        select s.relname seq, t.relname tbl, a.attname col
        from pg_depend d join pg_class s on s.oid=d.objid and s.relkind='S'
        join pg_class t on t.oid=d.refobjid join pg_attribute a on a.attrelid=t.oid and a.attnum=d.refobjsubid
        join pg_namespace n on n.oid=s.relnamespace
        where n.nspname='public' and s.relname like '{PREFIX}' and d.deptype='a' order by 1"""):
        out.append(f"alter sequence public.{ident(s['seq'])} owned by public.{ident(s['tbl'])}.{ident(s['col'])};")
    out.append("")

    # Indexes that do not back a constraint.
    for i in q(f"""
        select pg_get_indexdef(i.indexrelid) def
        from pg_index i join pg_class t on t.oid=i.indrelid join pg_class ic on ic.oid=i.indexrelid
        join pg_namespace n on n.oid=t.relnamespace
        where n.nspname='public' and t.relname like '{PREFIX}'
          and not exists (select 1 from pg_constraint c where c.conindid=i.indexrelid)
        order by t.relname, ic.relname"""):
        d = i["def"]
        d = d.replace("CREATE UNIQUE INDEX ", "CREATE UNIQUE INDEX IF NOT EXISTS ", 1) \
             .replace("CREATE INDEX ", "CREATE INDEX IF NOT EXISTS ", 1)
        out.append(d + ";")
    out.append("")

    # Functions named nb_* plus any function an nb_* trigger calls.
    for f in q(f"""
        select distinct p.proname, pg_get_functiondef(p.oid) def
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.prokind in ('f','p')
          and not exists (select 1 from pg_depend d where d.objid=p.oid and d.deptype='e')
          and (p.proname like '{PREFIX}' or p.oid in (
            select tg.tgfoid from pg_trigger tg join pg_class c on c.oid=tg.tgrelid
            where not tg.tgisinternal and c.relname like '{PREFIX}'))
        order by 1"""):
        out.append(f["def"].rstrip() + ";\n")

    # Views, in dependency order (a view that reads another view comes after it).
    views = q(f"""
        select c.oid::int oid, c.relname, pg_get_viewdef(c.oid, true) def,
               coalesce((select array_agg(distinct d.refobjid::int) from pg_rewrite r
                         join pg_depend d on d.objid=r.oid
                         where r.ev_class=c.oid and d.refobjid<>c.oid), '{{}}') deps,
               (select option_value from pg_options_to_table(c.reloptions) where option_name='security_invoker') invoker
        from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='public' and c.relkind='v' and c.relname like '{PREFIX}' order by 2""")
    by_oid = {v["oid"]: v for v in views}
    done: set[int] = set()

    def emit(v: dict) -> None:
        if v["oid"] in done:
            return
        done.add(v["oid"])
        for d in v["deps"]:
            if d in by_oid:
                emit(by_oid[d])
        opts = f" with (security_invoker = {v['invoker']})" if v["invoker"] else ""
        out.append(f"create or replace view public.{ident(v['relname'])}{opts} as\n{v['def'].rstrip().rstrip(';')};\n")

    for v in views:
        emit(v)

    # Triggers.
    for t in q(f"""
        select tg.tgname, c.relname, pg_get_triggerdef(tg.oid) def
        from pg_trigger tg join pg_class c on c.oid=tg.tgrelid join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='public' and not tg.tgisinternal and c.relname like '{PREFIX}' order by 2, 1"""):
        out.append(f"drop trigger if exists {ident(t['tgname'])} on public.{ident(t['relname'])};")
        out.append(t["def"] + ";")
    out.append("")

    # Policies.
    for p in q(f"""
        select tablename, policyname, permissive, roles::text[] roles, cmd, qual, with_check
        from pg_policies where schemaname='public' and tablename like '{PREFIX}' order by 1, 2"""):
        s = (f"create policy {ident(p['policyname'])} on public.{ident(p['tablename'])} as {p['permissive'].lower()}"
             f" for {p['cmd'].lower()} to {', '.join(p['roles'])}")
        if p["qual"]:
            s += f" using ({p['qual']})"
        if p["with_check"]:
            s += f" with check ({p['with_check']})"
        out.append(f"do $$ begin {s}; exception when duplicate_object then null; end $$;")
    out.append("")
    out += comments
    return "\n".join(out).rstrip() + "\n"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out")
    ap.add_argument("--check")
    a = ap.parse_args()
    sql = build()
    if a.check:
        same = Path(a.check).read_text() == sql
        print("no drift" if same else f"production differs from {a.check}")
        return 0 if same else 1
    if a.out:
        Path(a.out).write_text(sql)
        print(f"wrote {a.out} ({len(sql.splitlines())} lines)")
    else:
        sys.stdout.write(sql)
    return 0


if __name__ == "__main__":
    sys.exit(main())
