#!/usr/bin/env python3
"""Push the env vars this app reads (names from .env.example) to its Vercel project.

Values come from nutribiotic/.env and portfolio/.env.local in the agency checkout,
plus two fixed ones (NB_PUBLIC_ORIGIN, NB_HUBSPOT_WRITE_ENABLED). Nothing is printed
but the variable names. Run from the agency root:

  python3 osmotic-ventures/field-sales-os/scripts/vercel_env_sync.py [--scope <team>]
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
AGENCY = HERE.parent.parent
SOURCES = [AGENCY / "nutribiotic" / ".env", AGENCY / "portfolio" / ".env.local"]
FIXED = {"NB_PUBLIC_ORIGIN": "https://osmoticventures.com", "NB_HUBSPOT_WRITE_ENABLED": "false"}
ENVS = ("production", "preview")


def main() -> int:
    scope = []
    if "--scope" in sys.argv:
        scope = ["--scope", sys.argv[sys.argv.index("--scope") + 1]]
    names = sorted(set(re.findall(r"^([A-Z_]+)", (HERE / ".env.example").read_text(), re.M)))
    values: dict[str, str] = {}
    for src in SOURCES:
        if not src.exists():
            continue
        for line in src.read_text().splitlines():
            m = re.match(r"^([A-Z_]+)=(.*)$", line.strip())
            if m and m.group(1) in names and m.group(1) not in values:
                v = m.group(2).strip().strip('"').strip("'")
                if v:
                    values[m.group(1)] = v
    values.update(FIXED)
    for key, value in values.items():
        for env in ENVS:
            r = subprocess.run(
                ["vercel", "env", "add", key, env, "--force", *scope],
                input=value, text=True, capture_output=True, cwd=HERE,
            )
            ok = r.returncode == 0 or "already exists" in r.stderr
            why = "" if ok else " " + (r.stderr.strip().splitlines() or ["no error text"])[-1][:100]
            print(f"{'set' if ok else 'FAILED'} {key} ({env}){why}")
    missing = [n for n in names if n not in values]
    if missing:
        print("not on file, left unset:", " ".join(missing))
    return 0


if __name__ == "__main__":
    sys.exit(main())
