# SETUP — APAC scanner, exact steps in order

Two blocks, both yours (browser logins I can't do). ~7 minutes total.

> ⚠️ Everything here targets the **APAC "Lead Upload Template"** sheet:
> https://docs.google.com/spreadsheets/d/1e3yrsskEwanXffUtXLr2DwFUpyV_Zh4Ot9Gfdd-OtQs
> Do **not** run these steps on the *Event Leads* sheet — that one belongs to the other scanner.

App URL: **https://shmil123.github.io/badge-scanner-apac/**

Already done (no action needed):
- The APAC sheet has its `TEMPLATE` (26 columns, Push? checkboxes in column V) and `Config` tabs.
  The original `Sheet1` was left untouched.
- The app is published and its Google sign-in works (same GitHub Pages origin as the other
  scanner, so the existing OAuth client ID covers it).

---

## A. Anthropic API key (2 min)

You can reuse the existing `badge-scanner` key, or make a separate one to see APAC cost on its own.

1. Go to **console.anthropic.com** and sign in.
2. Left sidebar → **API keys** → **Create key**.
3. Name it `badge-scanner-apac`, click **Create**, and **copy the key now** (starts with
   `sk-ant-`) — it's shown only once. Keep it for step B5.

Cost: badge reading uses the cheapest model (Haiku). APAC badges cost slightly more than English
ones (two name versions per badge, plus the occasional romanize call) — still well under $1 per event.

## B. Apps Script backend (5 min)

1. Open the **APAC sheet** (link above).
2. Menu: **Extensions → Apps Script**. A code editor opens with a file called `Code.gs`.
3. **Delete everything** in that editor, then paste the full contents of
   [`apps-script/Code.gs`](apps-script/Code.gs) from this folder. Press **⌘S** to save.
4. Left sidebar → **gear icon (Project Settings)**.
5. Scroll to **Script Properties** → **Add script property**, add these two rows:
   | Property | Value |
   |---|---|
   | `SHARED_SECRET` | `46f0a726c0a6c54ed9f5869675a198aa` |
   | `ANTHROPIC_API_KEY` | the `sk-ant-…` key from block A |
   Click **Save script properties**.
   (This secret is APAC-only — it is deliberately different from the other scanner's.)
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

> **If "Anyone" is not offered** (Workspace policy): do B1-B11 from a personal Gmail account
> instead — first share the APAC sheet with that account as **Editor**, then open the sheet from
> that account and repeat from step 2.

> **If you later change Code.gs**: paste the new version, then **Deploy → Manage deployments →
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
