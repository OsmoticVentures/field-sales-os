#!/usr/bin/env python3
"""Point the `staging` git branch's Preview deployments at the staging database.

Every variable here is scoped to Preview AND git branch `staging` only, so it
overrides the all-branch Preview value for that one branch and leaves
production and every other preview untouched. Nothing is printed but the
variable names. Run from the agency root once the staging project exists and
bootstrap.mjs has filled it:

  python3 osmotic-ventures/field-sales-os/scripts/staging/vercel_staging_env.py --ref <staging ref> [--scope <team>] [--dry-run]

The service key is read from the Supabase Management API
(GET /v1/projects/{ref}/api-keys?reveal=true) with STAGING_SUPABASE_ACCESS_TOKEN,
or SUPABASE_ACCESS_TOKEN from nutribiotic/.env. It is never printed.

Set on branch `staging`:
  NB_STAGE=staging                        stage() says staging even without git metadata
  NB_SUPABASE_URL, NB_SUPABASE_SERVICE_ROLE_KEY   the staging project, never production
  NB_HUBSPOT_VISIT_WRITE_ENABLED=false    belt to stage.ts's braces: HubSpot is hard off
  NB_HUBSPOT_OUTBOUND_WRITE_ENABLED=false
  NB_SESSION_SECRET                       staging-only, so a production cookie never opens staging
  NB_WIDGET_TOKEN                         staging-only, for the same reason
  NB_PUBLIC_ORIGIN                        the staging alias, so deep links stay on staging
  NB_EXPENSES_GOOGLE_*                    a value Google rejects, so a staging expense
                                          never lands in the real Drive folder and sheet
"""

from __future__ import annotations

import json
import os
import re
import secrets
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent.parent
AGENCY = Path(os.environ["AGENCY_ROOT"]).resolve() if os.environ.get("AGENCY_ROOT") else HERE.parent.parent
PRODUCTION_REF = "giodrtaddvmkgvmzomxv"
BRANCH = "staging"
STAGING_ORIGIN = "https://field-sales-os-git-staging-juanarenasrec-4192s-projects.vercel.app"
GOOGLE_OFF = "disabled-on-staging"


def die(msg: str) -> None:
    print(msg, file=sys.stderr)
    sys.exit(1)


def arg(name: str) -> str | None:
    if name in sys.argv:
        i = sys.argv.index(name)
        if i + 1 < len(sys.argv) and not sys.argv[i + 1].startswith("--"):
            return sys.argv[i + 1]
    return None


def access_token() -> str:
    tok = os.environ.get("STAGING_SUPABASE_ACCESS_TOKEN", "").strip()
    if tok:
        return tok
    env_file = AGENCY / "nutribiotic" / ".env"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            m = re.match(r"^SUPABASE_ACCESS_TOKEN=(.*)$", line.strip())
            if m:
                return m.group(1).strip().strip('"').strip("'")
    die(f"No Supabase management token: set STAGING_SUPABASE_ACCESS_TOKEN or SUPABASE_ACCESS_TOKEN in {env_file}.")
    return ""


def service_key(ref: str, token: str) -> str:
    req = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{ref}/api-keys?reveal=true",
        headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            keys = json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        die(f"Could not read the staging project's API keys: HTTP {e.code}.")
    # The legacy service_role JWT first: the app sends the key as both apikey
    # and Bearer, which is the shape that key was made for. A newer secret key
    # is the fallback.
    for want in (lambda k: k.get("name") == "service_role", lambda k: k.get("type") == "secret"):
        for k in keys:
            if want(k) and k.get("api_key"):
                return k["api_key"]
    die("The staging project returned no service_role or secret key.")
    return ""


def main() -> int:
    ref = (arg("--ref") or os.environ.get("STAGING_SUPABASE_REF", "")).strip()
    if not ref:
        die("Give the staging project ref: --ref <ref>.")
    if ref == PRODUCTION_REF:
        die("Refusing: that is the production project. Staging gets its own project.")
    if not re.fullmatch(r"[a-z]{20}", ref):
        die(f'"{ref}" does not look like a Supabase project ref (20 lowercase letters).')
    scope = ["--scope", arg("--scope")] if arg("--scope") else []
    dry = "--dry-run" in sys.argv

    names = [
        "NB_STAGE", "NB_SUPABASE_URL", "NB_SUPABASE_SERVICE_ROLE_KEY",
        "NB_HUBSPOT_VISIT_WRITE_ENABLED", "NB_HUBSPOT_OUTBOUND_WRITE_ENABLED",
        "NB_SESSION_SECRET", "NB_WIDGET_TOKEN", "NB_PUBLIC_ORIGIN",
        "NB_EXPENSES_GOOGLE_CLIENT_ID", "NB_EXPENSES_GOOGLE_CLIENT_SECRET", "NB_EXPENSES_GOOGLE_REFRESH_TOKEN",
    ]
    if dry:
        print(f"Would set on Preview, branch {BRANCH} only, for staging project {ref}:")
        for n in names:
            print(f"  {n}")
        return 0

    values = {
        "NB_STAGE": "staging",
        "NB_SUPABASE_URL": f"https://{ref}.supabase.co",
        "NB_SUPABASE_SERVICE_ROLE_KEY": service_key(ref, access_token()),
        "NB_HUBSPOT_VISIT_WRITE_ENABLED": "false",
        "NB_HUBSPOT_OUTBOUND_WRITE_ENABLED": "false",
        "NB_SESSION_SECRET": secrets.token_hex(32),
        "NB_WIDGET_TOKEN": secrets.token_hex(24),
        "NB_PUBLIC_ORIGIN": STAGING_ORIGIN,
        "NB_EXPENSES_GOOGLE_CLIENT_ID": GOOGLE_OFF,
        "NB_EXPENSES_GOOGLE_CLIENT_SECRET": GOOGLE_OFF,
        "NB_EXPENSES_GOOGLE_REFRESH_TOKEN": GOOGLE_OFF,
    }
    assert list(values) == names
    if PRODUCTION_REF in values["NB_SUPABASE_URL"]:
        die("Refusing: the staging URL names the production project.")

    failed = 0
    for key, value in values.items():
        r = subprocess.run(
            ["vercel", "env", "add", key, "preview", BRANCH, "--value", value, "--yes", "--force", *scope],
            text=True, capture_output=True, cwd=HERE,
        )
        ok = r.returncode == 0
        # The CLI's own error text never contains the value, but trim it anyway.
        why = "" if ok else " " + (r.stderr.strip().splitlines() or ["no error text"])[-1][:100].replace(value, "***")
        print(f"{'set' if ok else 'FAILED'} {key} (preview, {BRANCH}){why}")
        failed += 0 if ok else 1
    if failed:
        return 1
    print(f"Push to `{BRANCH}` (or redeploy it) for these to take effect; check {STAGING_ORIGIN}/nb/api/health reads stage staging.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
