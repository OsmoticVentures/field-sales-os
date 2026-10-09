#!/usr/bin/env python3
"""Apply one ClientOS migration file to the live NutriBiotic Supabase project.

    python3 scripts/apply_migration.py supabase/0012_workflow_items.sql

Reads NB_SUPABASE_PROJECT_REF and SUPABASE_ACCESS_TOKEN from the agency's
nutribiotic/.env and runs the file through the Management API, the same call
scripts/staging/bootstrap.mjs makes. Every file in supabase/ is additive and
idempotent, so a rerun is safe. Prints the HTTP status, never a token.
"""
import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
ENV = HERE.parent.parent / "nutribiotic" / ".env"


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    sql_path = (HERE / sys.argv[1]) if not Path(sys.argv[1]).is_absolute() else Path(sys.argv[1])
    env = dict(re.findall(r"^([A-Z_]+)=(.*)$", ENV.read_text(), re.M))
    ref = env.get("NB_SUPABASE_PROJECT_REF", "").strip('"')
    tok = env.get("SUPABASE_ACCESS_TOKEN", "").strip('"')
    if not ref or not tok:
        print("nutribiotic/.env needs NB_SUPABASE_PROJECT_REF and SUPABASE_ACCESS_TOKEN.")
        return 1
    req = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{ref}/database/query",
        data=json.dumps({"query": sql_path.read_text()}).encode(),
        headers={"Authorization": f"Bearer {tok}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req) as r:
            print(f"{sql_path.name} -> {ref}: HTTP {r.status}")
            return 0
    except urllib.error.HTTPError as e:
        print(f"{sql_path.name} -> {ref}: HTTP {e.code} {e.read()[:300].decode(errors='replace')}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
