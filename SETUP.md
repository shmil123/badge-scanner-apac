# SETUP — APAC scanner, exact steps in order

Most of this is inherited from [`badge-scanner/`](../badge-scanner) — the Anthropic key, the rep
list and the Google sign-in client are all reused. What can't be inherited is the Apps Script
backend: the original one is **container-bound to the Event Leads sheet**, so `getActiveSpreadsheet()`
there returns the wrong workbook. APAC needs its own deployment.

Two ways to get it. **Path 1 is automated** — prefer it.

> ⚠️ Everything here targets the **APAC "Lead Upload Template"** sheet:
> https://docs.google.com/spreadsheets/d/1e3yrsskEwanXffUtXLr2DwFUpyV_Zh4Ot9Gfdd-OtQs
> Do **not** run these steps on the *Event Leads* sheet — that one belongs to the other scanner.

App URL: **https://shmil123.github.io/badge-scanner-apac/**

Already done (no action needed):
- The APAC sheet has its `TEMPLATE` (26 columns, Push? checkboxes in column V) and `Config` tabs.
  The original `Sheet1` was left untouched.
- `Config` carries the same 49 rep names as the Event Leads sheet.
- The app is published and its Google sign-in works (same GitHub Pages origin as the other
  scanner, so the existing OAuth client ID covers it).
- **Anthropic key**: reused from `quantum-intel/.env` — no new key, no console visit. Cost stays
  trivial (Haiku); APAC badges run slightly higher than English ones because each badge yields two
  name versions, plus the occasional romanize call. Still well under $1 per event.

---

## Path 1 — automated deploy (one click, recommended)

`deploy_apps_script.py` creates the bound script project, pushes `Code.gs`, versions it and
deploys the web app over the Apps Script API.

**One-time prerequisite**, both in a browser as matanw@classiq.io:

1. Enable the Apps Script API for the Cloud project behind our OAuth client:
   https://console.developers.google.com/apis/api/script.googleapis.com/overview?project=1000783419896
   → **Enable**. (Wait a minute for it to propagate.)
2. If the deploy still errors, flip the account-level switch at
   https://script.google.com/home/usersettings → **Google Apps Script API: On**.

Then:

```
cd badge-scanner-apac && python deploy_apps_script.py
```

The Google consent for this is already granted and cached in `google_token_script.json`
(gitignored — it holds a refresh token, never commit it). The script prints the `/exec` URL.
Re-run with `--redeploy` after any `Code.gs` edit; it ships a new version automatically, which
sidesteps the "just saving isn't enough" trap of the manual path.

Two design notes that let this work without Script Properties (which have no API):
- `SHARED_SECRET` is a constant in `Code.gs`, overridden by a `SHARED_SECRET` Script Property if
  you ever rotate. No security change — the secret already ships in the public PWA.
- The Anthropic key is written to an untracked `bootstrap.gs` that goes only into the script
  project, never into git. It sits behind sheet edit-access, the same boundary as a Script
  Property. `Code.gs` still prefers the Script Property if one is set.

---

## Path 2 — manual, if the API route is blocked (5 min)

1. Open the **APAC sheet** (link above).
2. Menu: **Extensions → Apps Script**. A code editor opens with a file called `Code.gs`.
3. **Delete everything** in that editor, then paste the full contents of
   [`apps-script/Code.gs`](apps-script/Code.gs) from this folder. Press **⌘S** to save.
4. Left sidebar → **gear icon (Project Settings)**.
5. Scroll to **Script Properties** → **Add script property** → add one row:
   | Property | Value |
   |---|---|
   | `ANTHROPIC_API_KEY` | the `ANTHROPIC_API_KEY=` value from `quantum-intel/.env` |
   Click **Save script properties**.
   (`SHARED_SECRET` needs no row — it's a constant in `Code.gs`, APAC-only and deliberately
   different from the other scanner's. Add a `SHARED_SECRET` property only to rotate it.)
6. In the editor's function dropdown pick **`authorizeDrive`** and click **▶ Run** once. Approve
   the permission prompt (**Advanced → Go to … (unsafe) → Allow**). This grants full Drive access
   so unreadable badge photos can be saved, and creates the `Badge Scanner APAC Photos` folder.
7. Top right: **Deploy → New deployment**.
8. Click the **gear next to "Select type"** → choose **Web app**.
9. Fill in:
   - Description: `badge scanner apac`
   - Execute as: **Me (matanw@classiq.io)**
   - Who has access: **Anyone**  ← must be exactly "Anyone", not "Anyone with a Google account"
10. Click **Deploy** and authorize if asked.
11. Copy the **Web app URL** (ends in `/exec`) and **paste it to me in Claude Code** — I'll put it
    in the app's CONFIG, bump the version, and redeploy. Until then the app shows
    "Not configured".

> **If "Anyone" is not offered** (Workspace policy): do steps 1-11 from a personal Gmail account
> instead — first share the APAC sheet with that account as **Editor**, then open the sheet from
> that account and repeat from step 2.

> **If you later change Code.gs** (path 2 only — path 1 handles this): paste the new version, then **Deploy → Manage deployments →
> pencil icon → Version: New version → Deploy**. (Just saving is NOT enough.)

---

## After setup — per event checklist

1. **Pre-create the event tab**: duplicate `TEMPLATE`, rename it to the event name. Reps then pick
   that one canonical name from chips/autocomplete instead of inventing variants. (If you skip it,
   the tab is auto-created from TEMPLATE on the first lead.)
2. Optional: print a poster QR for `https://<app-url>/?event=<Event%20Name>` so reps skip typing.
3. New rep? Nothing to do in the app — they sign in with their @classiq.io Google account.

## Sanity check before an event

Open the app on your phone, scan any badge (or photograph a business card in a native script),
and confirm the row appears on the right event tab with **both** the Latin and Native name
columns filled. If Native is filled but Latin is blank, the romanize step didn't run — usually
means `ANTHROPIC_API_KEY` is missing or the deployment wasn't re-versioned after an edit.
