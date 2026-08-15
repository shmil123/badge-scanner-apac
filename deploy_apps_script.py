#!/usr/bin/env python3
"""
Create + deploy the APAC badge-scanner Apps Script backend via the Apps Script API,
so nobody has to click through the Apps Script UI (SETUP.md block B).

What it does:
  1. Creates a container-bound script project on the APAC lead sheet (or reuses one).
  2. Pushes apps-script/Code.gs plus a manifest that declares the web app config.
  3. Pushes an untracked bootstrap.gs carrying the Anthropic key, so the key lives in
     the script project (edit-access only) and never in this public repo.
  4. Creates a version and a web-app deployment, and prints the /exec URL.

Auth: needs Google scopes beyond the event-leads token (script.projects /
script.deployments), so the first run opens a browser once and caches its own token in
google_token_script.json (gitignored — never commit it).

Prerequisite (one-time, in a browser): the Apps Script API must be ON at
https://script.google.com/home/usersettings

Usage:
  python deploy_apps_script.py                 # create or update + deploy
  python deploy_apps_script.py --redeploy      # push code + ship a new version
"""
import argparse
import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow

HERE = Path(__file__).parent
CLIENT_SECRET = HERE.parent / "event-leads" / "client_secret.json"
TOKEN = HERE / "google_token_script.json"
CODE = HERE / "apps-script" / "Code.gs"
# Untracked; created here from the key source below so it never enters git.
BOOTSTRAP = HERE / "bootstrap.gs"
KEY_SOURCE = HERE.parent / "quantum-intel" / ".env"  # reuse the existing Anthropic key

SHEET_ID = "1e3yrsskEwanXffUtXLr2DwFUpyV_Zh4Ot9Gfdd-OtQs"
PROJECT_TITLE = "Badge Scanner APAC backend"

SCOPES = [
    "https://www.googleapis.com/auth/script.projects",
    "https://www.googleapis.com/auth/script.deployments",
    # Also grant the scopes the deployed script itself declares, so the web app runs
    # as Matan without a separate interactive authorization.
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/script.external_request",
]

MANIFEST = {
    "timeZone": "Asia/Jerusalem",
    "dependencies": {},
    "exceptionLogging": "STACKDRIVER",
    "runtimeVersion": "V8",
    "oauthScopes": [
        "https://www.googleapis.com/auth/spreadsheets",
        "https://www.googleapis.com/auth/drive",
        "https://www.googleapis.com/auth/script.external_request",
    ],
    "webapp": {"access": "ANYONE_ANONYMOUS", "executeAs": "USER_DEPLOYING"},
}

API = "https://script.googleapis.com/v1"


def creds():
    if TOKEN.exists():
        c = Credentials.from_authorized_user_file(str(TOKEN), SCOPES)
        if c and c.valid:
            return c
        if c and c.expired and c.refresh_token:
            c.refresh(Request())
            TOKEN.write_text(c.to_json())
            return c
    print("Opening a browser once to grant Apps Script deploy access...")
    c = InstalledAppFlow.from_client_secrets_file(str(CLIENT_SECRET), SCOPES).run_local_server(port=0)
    TOKEN.write_text(c.to_json())
    return c


def call(c, method, path, body=None):
    req = urllib.request.Request(
        API + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": "Bearer " + c.token, "Content-Type": "application/json"},
        method=method,
    )
    try:
        return json.loads(urllib.request.urlopen(req).read() or "{}")
    except urllib.error.HTTPError as e:
        detail = e.read().decode()
        try:
            err = json.loads(detail)["error"]
            msg = f"{err.get('status')}: {err.get('message')}"
        except Exception:
            msg = detail[:500]
        raise SystemExit(f"\nApps Script API {e.code} on {method} {path}\n  {msg}\n")


def anthropic_key():
    m = re.search(r"^ANTHROPIC_API_KEY=(\S+)", KEY_SOURCE.read_text(), re.M)
    if not m:
        sys.exit(f"No ANTHROPIC_API_KEY found in {KEY_SOURCE}")
    return m.group(1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--redeploy", action="store_true", help="push code + ship a new version")
    args = ap.parse_args()

    c = creds()
    state_file = HERE / ".script_project.json"
    state = json.loads(state_file.read_text()) if state_file.exists() else {}

    script_id = state.get("scriptId")
    if not script_id:
        print(f"Creating a bound script project on the APAC sheet...")
        proj = call(c, "POST", "/projects", {"title": PROJECT_TITLE, "parentId": SHEET_ID})
        script_id = proj["scriptId"]
        state["scriptId"] = script_id
        state_file.write_text(json.dumps(state, indent=2))
    print(f"scriptId: {script_id}")

    key = anthropic_key()
    BOOTSTRAP.write_text(
        "// Untracked (see .gitignore) — this repo is public.\n"
        "// Code.gs prefers the ANTHROPIC_API_KEY Script Property and falls back to this.\n"
        f'var BOOTSTRAP_ANTHROPIC_KEY = "{key}";\n'
    )

    print("Pushing Code.gs + manifest...")
    call(c, "PUT", f"/projects/{script_id}/content", {
        "files": [
            {"name": "appsscript", "type": "JSON", "source": json.dumps(MANIFEST, indent=2)},
            {"name": "Code", "type": "SERVER_JS", "source": CODE.read_text()},
            {"name": "bootstrap", "type": "SERVER_JS", "source": BOOTSTRAP.read_text()},
        ]
    })

    ver = call(c, "POST", f"/projects/{script_id}/versions",
               {"description": "deployed by deploy_apps_script.py"})
    n = ver["versionNumber"]
    print(f"Created version {n}")

    dep_id = state.get("deploymentId")
    if dep_id and args.redeploy or dep_id:
        call(c, "PUT", f"/projects/{script_id}/deployments/{dep_id}",
             {"deploymentConfig": {"scriptId": script_id, "versionNumber": n,
                                   "manifestFileName": "appsscript",
                                   "description": "badge scanner apac"}})
        dep = {"deploymentId": dep_id}
        print(f"Updated deployment {dep_id} → version {n}")
    else:
        dep = call(c, "POST", f"/projects/{script_id}/deployments",
                   {"versionNumber": n, "manifestFileName": "appsscript",
                    "description": "badge scanner apac"})
        state["deploymentId"] = dep["deploymentId"]
        state_file.write_text(json.dumps(state, indent=2))
        print(f"Created deployment {dep['deploymentId']}")

    url = f"https://script.google.com/macros/s/{state['deploymentId']}/exec"
    print("\n  Web app URL:", url)
    print("\nPaste this into CONFIG.APPS_SCRIPT_URL in docs/index.html.")


if __name__ == "__main__":
    main()
