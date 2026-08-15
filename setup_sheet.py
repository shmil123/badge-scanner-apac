#!/usr/bin/env python3
"""
One-time: prepare the APAC "Lead Upload Template" Google Sheet that badge-scanner-apac writes into.

This is the APAC sibling of ../event-leads/setup_sheet.py. It targets a DIFFERENT workbook
with a DIFFERENT schema — do not point either script at the other's sheet.

What it does:
- Adds a "TEMPLATE" tab with the 26-column APAC header + real checkboxes in the Push? column.
  Duplicate that tab per event (rename to the event name), or let the app create it on first lead.
- Adds a "Config" tab (rep-name fallback list) if missing.
- Leaves the workbook's original "Sheet1" alone — it's the upload format the sheet shipped with,
  and Code.gs treats it as a reserved tab so it never shows up as an event.

Columns A-O are the APAC lead-upload format and keep their exact names (trailing spaces
included) and positions. Operational columns the scanner needs are appended from P onward.

Auth reuses the same Google OAuth as the event-leads pipeline (client_secret.json +
google_token.json are read from ../event-leads/ by default).

Usage:
  python setup_sheet.py
  python setup_sheet.py --id <SHEET_ID>
"""
import argparse
import sys
from pathlib import Path

import gspread

HERE = Path(__file__).parent
CREDS_DIR = HERE.parent / "event-leads"

# The APAC "Lead Upload Template" workbook.
SHEET_ID = "1e3yrsskEwanXffUtXLr2DwFUpyV_Zh4Ot9Gfdd-OtQs"

TEMPLATE_TAB = "TEMPLATE"
# Schema owned jointly with badge-scanner-apac/apps-script/Code.gs (HEADERS) — keep in sync.
# A-O: the APAC upload template, verbatim (trailing spaces are the sheet's own, left intact
# so anything matching on header text keeps working). P-Z: scanner/review/enrichment columns.
HEADER = [
    "First Name", "Last Name ", "Native First Name", "Native Last Name",
    "Company ", "Title", "Email", "Phone", "Mobile",
    "Street Address", "City", "State", "Country",
    "Lead Source", "Notes ",
    "LinkedIn URL", "Event", "Captured By", "Captured At",
    "Temperature", "Follow-up", "Push?", "HubSpot Status", "Badge Photo",
    "Lead Type", "Company URL",
]
PUSH_COL_INDEX = HEADER.index("Push?")  # 0-based → column V


def col_letter(idx0):
    """0-based column index → A1 letter(s)."""
    s, n = "", idx0 + 1
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--id", default=SHEET_ID, help="APAC lead sheet ID")
    args = ap.parse_args()

    client_secret = CREDS_DIR / "client_secret.json"
    if not client_secret.exists():
        sys.exit(f"ERROR: {client_secret} not found.")

    print("Connecting to Google (browser opens on first run)...")
    gc = gspread.oauth(
        credentials_filename=str(client_secret),
        authorized_user_filename=str(CREDS_DIR / "google_token.json"),
    )

    ss = gc.open_by_key(args.id)
    print(f"Opened workbook: {ss.title}")

    existing = {w.title: w for w in ss.worksheets()}

    ws = existing.get(TEMPLATE_TAB) or ss.add_worksheet(
        title=TEMPLATE_TAB, rows=200, cols=len(HEADER)
    )
    if ws.col_count < len(HEADER):
        ws.resize(rows=max(ws.row_count, 200), cols=len(HEADER))
    ws.update([HEADER], value_input_option="RAW")
    ws.freeze(rows=1)
    end = col_letter(len(HEADER) - 1)
    ws.format(f"A1:{end}1", {"textFormat": {"bold": True}})

    # Real checkboxes down the Push? column so review is one click.
    #
    # IMPORTANT: only validate a modest range (not thousands of empty rows). Data validation /
    # formatting on empty rows makes the Sheets API treat the column as "filled" to the bottom,
    # so append_rows / connector appends jump PAST it (e.g. to row 2001) instead of row 2.
    # Keep the grid small here, and ALWAYS write lead rows at an explicit range (the first empty
    # row), never with a naive append onto a pre-validated grid.
    ws.resize(rows=200)
    ss.batch_update({
        "requests": [{
            "setDataValidation": {
                "range": {
                    "sheetId": ws.id,
                    "startRowIndex": 1, "endRowIndex": 200,
                    "startColumnIndex": PUSH_COL_INDEX, "endColumnIndex": PUSH_COL_INDEX + 1,
                },
                "rule": {"condition": {"type": "BOOLEAN"}, "showCustomUi": True},
            }
        }]
    })
    print(f"✓ '{TEMPLATE_TAB}' ready — {len(HEADER)} columns, Push? checkboxes in "
          f"column {col_letter(PUSH_COL_INDEX)}.")

    if "Config" not in existing:
        cfg = ss.add_worksheet(title="Config", rows=50, cols=2)
        cfg.update([["Rep Name (must match rep_map.json)"], ["Matan Wisebitan"]],
                   value_input_option="RAW")
        print("✓ 'Config' tab created (rep-name fallback list).")
    else:
        print("• 'Config' tab already exists — left as is.")

    if "Sheet1" in existing:
        print("• 'Sheet1' left untouched (reserved in Code.gs — never treated as an event).")

    print(f"\n  URL: {ss.url}\n  ID : {ss.id}")
    print("\nNext: duplicate TEMPLATE per event and rename it to the event name.")


if __name__ == "__main__":
    main()
