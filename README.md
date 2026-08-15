# Badge Scanner APAC — booth lead capture on reps' phones, in any APAC script

The APAC sibling of [`badge-scanner/`](../badge-scanner). Same 20-second capture flow, but built
for events in Thailand, Vietnam, China, Japan, Korea, Singapore, India: badges print names in
their own script, in English, or in both, and the sheet on the other end is the APAC
**Lead Upload Template**, not the EMEA/US *Event Leads* workbook.

**Flow per lead (~20 seconds):** Scan badge QR → if the QR has contact info it prefills;
if not, snap a photo of the badge and the details are extracted automatically → mark Hot
(or Regular) → pick a lead type (Partnership / Sales / Academia / Other) → note → Save.
Works offline; syncs when the phone gets signal.

## This is a separate entity from badge-scanner

Deliberately, at every layer — APAC events run on different languages, sheets and processes,
so nothing here can break the EMEA/US scanner (or vice versa):

| | badge-scanner | badge-scanner-apac |
|---|---|---|
| Sheet | *Event Leads* (`1kMXaQ…`) | *Lead Upload Template* (`1e3yrs…`) |
| Schema | 21 cols | 26 cols, incl. Native First/Last Name |
| Apps Script | own deployment + secret | **own** deployment + secret |
| Repo / Pages | `shmil123/badge-scanner` | `shmil123/badge-scanner-apac` |
| Phone storage | IndexedDB `badge-scanner`, `bs_*` keys | IndexedDB `badge-scanner-apac`, `bsa_*` keys |
| SW cache | `badge-scanner-v14` | `badge-scanner-apac-v1` |

The storage split matters: both apps are served from `shmil123.github.io`, so they share an
origin. Without separate DB names and key prefixes a rep with both installed would see one
app's leads and event list inside the other.

The only thing shared on purpose is the **Google OAuth client ID** — same origin, so rep
sign-in works in both without a second Cloud project.

## Languages

Handled in three places, so a badge printed only in Thai still produces a CRM-usable row:

1. **Badge photo → Claude Haiku vision** returns the name twice: `native_first_name` /
   `native_last_name` exactly as printed, and `first_name` / `last_name` in Latin — copied from
   the badge if it prints both, otherwise transliterated (Hepburn / Revised Romanization /
   Hanyu Pinyin / RTGS). The prompt also encodes family-name-first ordering for CJK and
   Vietnamese, and tells the model to ignore Thai nicknames in parentheses.
2. **Badge QR (vCard/MECARD)** is parsed client-side: a native-script name is routed to the
   Native columns and never into the Latin ones, while `X-PHONETIC-*` (Japanese kana vCards)
   and MECARD `SOUND` fill the Latin pair when they're Latin themselves.
3. **`romanize` backend action** fills the Latin name from the native one — on demand from the
   form ("fill the Latin name for me"), and automatically at sync time for any lead that has a
   native name but no Latin one.

Vietnamese is Latin-script, so it stays in the normal name fields and only loses its diacritics
at romanize time. Native-script *company* names are romanized into `Company` with the original
preserved in `Notes` as `native-company:…`; the detected badge language is logged there too.

The PWA's font stack falls back from Lato (no CJK/Thai glyphs) to the iOS and Android system
fonts for each script, so native names render instead of tofu boxes.

## Architecture

```
Rep's phone (PWA on GitHub Pages)     Apps Script Web App (bound to sheet)     Lead Upload Template
 QR scan / badge photo / manual   →    secret check, UUID dedupe (_sync tab),   per-event tab, 26 cols
 IndexedDB offline queue               Haiku extraction + romanization,         (A-O = upload format,
                                       LockService + first-empty-row write       P-Z = scanner/review)
```

- `docs/` — the PWA (static, hosted on GitHub Pages)
- `apps-script/Code.gs` — the backend; **source of truth lives here**, pasted into the
  sheet-bound Apps Script project. If you edit Code.gs, re-paste and create a new deployment.
- `setup_sheet.py` — creates/refreshes the sheet's `TEMPLATE` + `Config` tabs.

## Sheet schema (26 columns)

`A-O` are the APAC upload format and must keep their exact names (trailing spaces included)
and positions — a downstream upload maps on them. Everything from `P` is the scanner's:

```
A  First Name        (Latin)      N  Lead Source   ("Event")
B  Last Name         (Latin)      O  Notes         (rep note | native-company | badge-language | badge-id)
C  Native First Name              P  LinkedIn URL
D  Native Last Name               Q  Event
E  Company                        R  Captured By
F  Title                          S  Captured At
G  Email                          T  Temperature
H  Phone                          U  Follow-up
I  Mobile                         V  Push?            ← review gate
J  Street Address                 W  HubSpot Status
K  City                           X  Badge Photo
L  State                          Y  Lead Type
M  Country                        Z  Company URL
```

`State` and `Company URL` stay blank at capture — enrichment fills them at push time.
The workbook's original `Sheet1` is reserved: never written to, never listed as an event.

## One-time setup (Matan)

See **[SETUP.md](SETUP.md)**. Blocks A-B (Anthropic key, Apps Script deployment) must be done
against the APAC sheet specifically — that's the whole setup.

**Rep identity**: reps sign in once with their @classiq.io Google account; their Google name
becomes Captured By. If sign-in fails, the app falls back to a name dropdown fed from the
sheet's `Config` tab.

## Per event

1. **Pre-create the event tab** (duplicate `TEMPLATE`, rename it to the event) so reps pick a
   single canonical name. Pre-created tabs appear in the app as tappable chips + autocomplete.
   A name that isn't already an event triggers a "create it as a NEW event?" confirm.
   Event names in CJK/Thai are fine — fuzzy matching keeps non-Latin names intact.
2. Print a booth poster QR pointing to `https://<pages-url>/?event=<Event%20Name>`. Tell reps to
   open it **while on WiFi once** so the app caches for offline.

## Rules for reps

- **Sync before leaving the venue each day** (red banner appears if leads sit unsynced >12h —
  iOS can evict site storage after ~7 days of not opening the page).
- Badge in Thai/Chinese/Japanese/Korean? Just photograph it — both name versions are read
  automatically. Typing manually: put the name as printed in the **Native** fields and tap
  "fill the Latin name for me".
- Camera blocked? iPhone: aA menu → Website Settings → Camera → Allow. Or use **Type manually**.
- Blurry badge photo? Retake — the thumbnail on the form shows what the extractor sees.

## Security & privacy model

Identical to `badge-scanner/`, with its own secret and its own sheet:

- Reps' phones: IndexedDB, per device; synced leads auto-purge after 30 days.
- Google Sheet + Drive photos folder (`Badge Scanner APAC Photos`): under the Classiq Google
  account; access = sheet sharing.
- Anthropic API: badge photos and native-name strings are processed transiently for extraction
  and transliteration; API data is not used for model training by default.
- The shared secret + Apps Script URL are visible in this public repo. That's friction against
  bots, not real secrecy; blast radius is bounded by per-minute rate limits on every action, a
  payload size cap, human review before anything reaches the CRM, and the API key living only
  in Script Properties. Rotating: change `SHARED_SECRET` in Script Properties + CONFIG in
  index.html.

**Rep etiquette:** ask the attendee before photographing their badge — same consent norm as the
official event scanners.

## Known trade-offs

- Transliteration is a best guess, not an authority. Chinese and Korean surnames in particular
  have multiple accepted romanizations (Kim/Gim, Lee/Yi, Zhang/Chang); the native columns are
  the ground truth, and the Latin ones are what the CRM gets. Spot-check before pushing.
- Badge QRs that contain only a registration ID can't be resolved without the organizer's paid
  lead-retrieval API; the raw ID is saved in Notes as `badge-id:<…>`.
- The HubSpot push (`/event-leads-push`) reads the *Event Leads* schema and does **not**
  understand this one — the APAC sheet's own upload path is the destination for now.
- Never use `appendRow` on event tabs in Code.gs — the Push? checkbox validation (rows 2-200)
  makes appends jump to row 2001.
