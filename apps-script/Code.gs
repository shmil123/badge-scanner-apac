/**
 * Badge Scanner APAC backend — bound to the "Lead Upload Template" Google Sheet
 * (1e3yrsskEwanXffUtXLr2DwFUpyV_Zh4Ot9Gfdd-OtQs).
 *
 * SEPARATE ENTITY from badge-scanner (EMEA/US). Different sheet, different schema,
 * different secret, different deployment. Never point this at the "Event Leads" sheet.
 *
 * Deploy: Extensions → Apps Script → paste this file → Deploy → New deployment
 *   → Web app → Execute as: Me → Who has access: Anyone → copy the /exec URL.
 * After edits: Deploy → Manage deployments → pencil → Version: New version → Deploy.
 *
 * Script Properties required (Project Settings → Script Properties):
 *   SHARED_SECRET      — must match CONFIG.SHARED_SECRET in the PWA's index.html
 *   ANTHROPIC_API_KEY  — for badge-photo field extraction (Claude Haiku vision)
 */

// Columns A–O are the APAC "Lead Upload Template" format and must keep their exact
// names (trailing spaces included) and positions — a downstream upload maps on them.
// Operational columns the scanner needs are appended from P onward.
var HEADERS = [
  "First Name", "Last Name ", "Native First Name", "Native Last Name",
  "Company ", "Title", "Email", "Phone", "Mobile",
  "Street Address", "City", "State", "Country",
  "Lead Source", "Notes ",
  "LinkedIn URL", "Event", "Captured By", "Captured At",
  "Temperature", "Follow-up", "Push?", "HubSpot Status", "Badge Photo",
  "Lead Type", "Company URL"
];
// 0-based column indexes, used everywhere instead of magic numbers.
var COL = {
  first: 0, last: 1, nativeFirst: 2, nativeLast: 3,
  company: 4, title: 5, email: 6, phone: 7, mobile: 8,
  street: 9, city: 10, state: 11, country: 12,
  leadSource: 13, notes: 14,
  linkedin: 15, event: 16, capturedBy: 17, capturedAt: 18,
  temperature: 19, followUp: 20, push: 21, hubspotStatus: 22, badgePhoto: 23,
  leadType: 24, companyUrl: 25
};
var PUSH_COL = COL.push + 1; // 22 → column V
var LEAD_SOURCE = "Event";   // fixed value the upload template expects
// "Sheet1" is the original upload template the sheet shipped with — reserved so it
// never shows up as an event and never gets written to.
var RESERVED_TABS = ["TEMPLATE", "Config", "_sync", "Sheet1"];
var HAIKU_MODEL = "claude-haiku-4-5-20251001";
var PHOTO_FOLDER = "Badge Scanner APAC Photos";
// Matches CONFIG.SHARED_SECRET in the PWA. Public by necessity (it ships in the
// client); a SHARED_SECRET Script Property overrides it if you ever rotate.
var SHARED_SECRET = "46f0a726c0a6c54ed9f5869675a198aa";

// Config moved behind the shared secret (POST action=config) — a bare GET must
// not enumerate event names or rep names.
function doGet(e) {
  return json_({ ok: true });
}

function handleConfig_(req) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureInfraTabs_(ss);
  var events = ss.getSheets()
    .map(function (s) { return s.getName(); })
    .filter(function (n) { return RESERVED_TABS.indexOf(n) === -1; });
  // Read to the last populated row, never a fixed range — a hardcoded A2:A50 silently
  // truncated the rep list the moment the roster passed 49 names.
  var cfg = ss.getSheetByName("Config");
  var lastRep = cfg.getLastRow();
  var reps = lastRep < 2 ? [] : cfg.getRange(2, 1, lastRep - 1, 1).getValues()
    .map(function (r) { return String(r[0]).trim(); })
    .filter(function (v) { return v; });
  return json_({ ok: true, events: events, reps: reps });
}

function doPost(e) {
  var req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: "bad JSON" });
  }
  // The secret also ships in the public PWA, so a Script Property adds no real
  // secrecy over the constant below — it only lets you rotate without a redeploy.
  var secret = PropertiesService.getScriptProperties().getProperty("SHARED_SECRET") || SHARED_SECRET;
  if (!secret || req.secret !== secret) {
    return json_({ ok: false, error: "unauthorized" });
  }
  // Bound abuse: the secret ships in a public web app, so cap request rates
  // (CacheService counters) and photo payload size. Booth traffic never comes
  // close to these numbers.
  if (req.photoBase64 && req.photoBase64.length > 3000000) {
    return json_({ ok: false, error: "photo too large" });
  }
  var limits = { extract: 20, submit: 120, config: 60, history: 30, romanize: 40 };
  if (!rateLimit_(req.action, limits[req.action] || 30)) {
    return json_({ ok: false, error: "rate limited — try again in a minute" });
  }
  try {
    if (req.action === "config") return handleConfig_(req);
    if (req.action === "extract") return handleExtract_(req);
    if (req.action === "submit") return handleSubmit_(req);
    if (req.action === "history") return handleHistory_(req);
    if (req.action === "romanize") return handleRomanize_(req);
    return json_({ ok: false, error: "unknown action" });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function rateLimit_(kind, maxPerMinute) {
  var cache = CacheService.getScriptCache();
  var key = "rl_" + kind + "_" + Math.floor(Date.now() / 60000);
  var n = Number(cache.get(key) || 0) + 1;
  cache.put(key, String(n), 90);
  return n <= maxPerMinute;
}

// ---------- history: per-event aggregates for the app's History/Today tabs ----------

function handleHistory_(req) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureInfraTabs_(ss);
  var out = [];
  ss.getSheets().forEach(function (ws) {
    var name = ws.getName();
    if (RESERVED_TABS.indexOf(name) !== -1) return;
    var vals = ws.getDataRange().getValues();
    var total = 0, hot = 0, mine = 0, pushed = 0;
    for (var i = 1; i < vals.length; i++) {
      var r = vals[i];
      var has = false;
      // Ignore the review-owned tail (Push? onward) when deciding "is this a real row".
      for (var j = 0; j < Math.min(r.length, COL.push); j++) {
        if (r[j] !== "" && r[j] !== false) { has = true; break; }
      }
      if (!has) continue;
      total++;
      if (String(r[COL.temperature]) === "Hot") hot++;
      if (req.rep && String(r[COL.capturedBy]) === req.rep) mine++;
      if (r[COL.hubspotStatus]) pushed++;
    }
    out.push({ event: name, total: total, hot: hot, mine: mine, pushed: pushed });
  });
  return json_({ ok: true, events: out });
}

// ---------- extract: badge photo → structured fields via Claude Haiku ----------

function handleExtract_(req) {
  if (!req.photoBase64) return json_({ ok: false, error: "no photo" });
  var fields = extractFromPhoto_(req.photoBase64);
  return json_({ ok: true, fields: fields });
}

// APAC badges come in Thai, Vietnamese, Chinese (Simplified/Traditional), Japanese,
// Korean, Bahasa, Hindi — often with a Latin/English line as well, often not. We ask
// for BOTH representations in one pass: the native script exactly as printed, and a
// Latin/romanized version for the CRM. If only one is printed, the model produces the
// other by transliteration rather than leaving a blank.
var EXTRACT_PROMPT =
  "This is a photo of a conference attendee badge from an event in the Asia-Pacific region. " +
  "The badge may be printed in Thai, Vietnamese, Simplified or Traditional Chinese, Japanese, " +
  "Korean, Bahasa Indonesia/Malaysia, Hindi, or English — often two of these at once.\n\n" +
  "Extract the attendee's details and the event/conference name. Respond with ONLY a JSON " +
  "object, no other text:\n" +
  '{"first_name":"","last_name":"","native_first_name":"","native_last_name":"",' +
  '"title":"","company":"","native_company":"","email":"","phone":"","mobile":"",' +
  '"city":"","country":"","event_name":"","language":""}\n\n' +
  "Name rules — this matters most:\n" +
  "- native_first_name / native_last_name: the name EXACTLY as printed in its native script " +
  "(Thai, Chinese, Japanese, Korean, etc.), character for character. Leave both empty if the " +
  "badge only shows a Latin-alphabet name.\n" +
  "- first_name / last_name: a Latin-alphabet version. If the badge prints one (many APAC " +
  "badges show both), copy it exactly. If the badge shows ONLY native script, transliterate it " +
  "using the standard romanization for that language (Hepburn for Japanese, Revised " +
  "Romanization for Korean, Hanyu Pinyin without tone marks for Chinese, RTGS for Thai, " +
  "Vietnamese with diacritics removed) — never leave these empty when a native name is present.\n" +
  "- Split names correctly per language: Chinese/Japanese/Korean badges print FAMILY name " +
  "first (e.g. 田中 太郎 → last=Tanaka, first=Taro; 김민준 → last=Kim, first=Minjun). " +
  "Vietnamese prints family name first too (Nguyễn Văn An → last=Nguyen, first=An — 'Văn' is a " +
  "middle name). Thai badges usually print given name first, and often show a nickname in " +
  "parentheses — ignore the nickname.\n\n" +
  "Other fields:\n" +
  "- title / company: Latin/English if printed; otherwise transliterate or translate the " +
  "company name to its common English form. Put the original native-script company name in " +
  "native_company (empty if the company is printed in Latin script).\n" +
  "- phone vs mobile: a number labelled mobile/cell/手机/휴대폰/มือถือ/di động goes in mobile, " +
  "any other number in phone.\n" +
  "- city / country: only if printed on the badge.\n" +
  "- event_name: from the badge header/footer or lanyard area, in English if shown that way. " +
  "Ignore sponsor logos.\n" +
  "- language: the primary script of the badge — one of thai, vietnamese, chinese, japanese, " +
  "korean, bahasa, hindi, english, other.\n\n" +
  "Use an empty string for anything not visible. The largest text is usually the attendee name; " +
  "company and job title are usually below it.";

function extractFromPhoto_(photoBase64) {
  var payload = {
    model: HAIKU_MODEL,
    max_tokens: 800,
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: photoBase64 } },
        { type: "text", text: EXTRACT_PROMPT }
      ]
    }]
  };
  var f = anthropic_(payload);
  return {
    first_name: f.first_name || "", last_name: f.last_name || "",
    native_first_name: f.native_first_name || "", native_last_name: f.native_last_name || "",
    title: f.title || "", company: f.company || "", native_company: f.native_company || "",
    email: f.email || "", phone: f.phone || "", mobile: f.mobile || "",
    city: f.city || "", country: f.country || "",
    event_name: f.event_name || "", language: f.language || ""
  };
}

// ---------- romanize: native-script name (from a QR/vCard or typed by the rep) → Latin ----------
// Badge QRs in APAC frequently carry ONLY the native-script name. HubSpot and the
// upload template need a Latin name, so the app asks the backend to transliterate.

function handleRomanize_(req) {
  var first = String(req.first || "").slice(0, 80);
  var last = String(req.last || "").slice(0, 80);
  var company = String(req.company || "").slice(0, 120);
  if (!first && !last && !company) return json_({ ok: false, error: "nothing to romanize" });
  var f = anthropic_({
    model: HAIKU_MODEL,
    max_tokens: 300,
    messages: [{
      role: "user",
      content: [{
        type: "text",
        // The caller already knows which field is the given name and which is the family
        // name, so this step must NOT re-order them: name order is language-specific
        // (Thai prints given name first, CJK/Vietnamese family name first) and guessing
        // it here swapped Thai names. Ordering is decided in EXTRACT_PROMPT, where the
        // model can actually see the badge.
        text: "Transliterate these contact details into the Latin alphabet for a CRM. " +
          "Use Hepburn for Japanese, Revised Romanization for Korean, Hanyu Pinyin without " +
          "tone marks for Chinese, RTGS for Thai, and Vietnamese with diacritics removed. " +
          "Translate the company name to its common English form if it has one, otherwise " +
          "transliterate it.\n\n" +
          "Transliterate each field IN PLACE. The given name stays the given name and the " +
          "family name stays the family name — do NOT swap, reorder, merge or split them. " +
          "Romanize the whole of each name: every syllable, nothing dropped " +
          "(e.g. 민준 → Minjun, not Jun).\n\n" +
          "Given name: " + (first || "(none)") + "\n" +
          "Family name: " + (last || "(none)") + "\n" +
          "Company: " + (company || "(none)") + "\n\n" +
          'Respond with ONLY JSON: {"first_name":"","last_name":"","company":""} — ' +
          "first_name is the transliterated given name, last_name the transliterated family name."
      }]
    }]
  });
  return json_({
    ok: true,
    fields: {
      first_name: f.first_name || "", last_name: f.last_name || "", company: f.company || ""
    }
  });
}

// The Script Property is the intended home for the key. When this project was
// deployed by deploy_apps_script.py the key instead arrives in an untracked
// bootstrap.gs file (never committed — this repo is public), so fall back to it.
function anthropicKey_() {
  var key = PropertiesService.getScriptProperties().getProperty("ANTHROPIC_API_KEY");
  if (key) return key;
  if (typeof BOOTSTRAP_ANTHROPIC_KEY !== "undefined" && BOOTSTRAP_ANTHROPIC_KEY) {
    return BOOTSTRAP_ANTHROPIC_KEY;
  }
  throw new Error("ANTHROPIC_API_KEY script property not set");
}

// Shared Anthropic call → parsed JSON object from the model's text response.
function anthropic_(payload) {
  var key = anthropicKey_();
  var resp = UrlFetchApp.fetch("https://api.anthropic.com/v1/messages", {
    method: "post",
    contentType: "application/json",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() !== 200) {
    throw new Error("Anthropic API " + resp.getResponseCode() + ": " + resp.getContentText().slice(0, 300));
  }
  var text = JSON.parse(resp.getContentText()).content[0].text;
  var match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("no JSON in model response");
  return JSON.parse(match[0]);
}

// ---------- submit: create or update one lead row (upsert by uuid) ----------

function handleSubmit_(req) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureInfraTabs_(ss);
  var lead = req.lead || {};
  if (!req.uuid) return json_({ ok: false, error: "missing uuid" });
  var eventName = sanitizeEventName_(lead.event);
  if (!eventName) return json_({ ok: false, error: "missing event" });
  if (RESERVED_TABS.some(function (t) { return t.toLowerCase() === eventName.toLowerCase(); })) {
    return json_({ ok: false, error: "reserved tab name: " + eventName });
  }

  var fields = lead.fields || {};
  var photoUrl = "";

  // New photo lead with no typed name: extract in the background (this call IS the
  // background — the rep already saved and moved on). Keep this outside the lock.
  var sync = ss.getSheetByName("_sync");
  var existing = findUuid_(sync, req.uuid);
  var noTypedName = !fields.first_name && !fields.last_name &&
                    !fields.native_first_name && !fields.native_last_name;
  if (!existing && req.photoBase64 && noTypedName) {
    try {
      var ex = extractFromPhoto_(req.photoBase64);
      fields.first_name = ex.first_name; fields.last_name = ex.last_name;
      fields.native_first_name = ex.native_first_name; fields.native_last_name = ex.native_last_name;
      fields.title = ex.title; fields.company = ex.company;
      fields.native_company = ex.native_company;
      fields.email = fields.email || ex.email;
      fields.phone = fields.phone || ex.phone;
      fields.mobile = fields.mobile || ex.mobile;
      fields.city = fields.city || ex.city;
      fields.country = fields.country || ex.country;
      fields.language = ex.language;
      var gotSomething = ex.first_name || ex.last_name || ex.native_first_name ||
                         ex.native_last_name || ex.company;
      if (!gotSomething) {
        photoUrl = savePhotoToDrive_(req.uuid, req.photoBase64); // unreadable — keep the photo
        fields.extractError = "nothing recognizable";
      }
    } catch (err) {
      photoUrl = savePhotoToDrive_(req.uuid, req.photoBase64);
      fields.extractError = String(err);
    }
  }
  // Native name but no Latin one (typical of a native-script badge QR that the rep
  // saved offline): fill the Latin columns so the CRM row is usable.
  if ((fields.native_first_name || fields.native_last_name) &&
      !fields.first_name && !fields.last_name) {
    try {
      var r = anthropicRomanize_(fields.native_first_name, fields.native_last_name, fields.company);
      fields.first_name = r.first_name; fields.last_name = r.last_name;
      if (r.company && !isLatin_(fields.company)) {
        fields.native_company = fields.native_company || fields.company;
        fields.company = r.company;
      }
    } catch (err) { /* keep the native name only — the rep can fix it in the sheet */ }
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    existing = findUuid_(sync, req.uuid); // re-check under the lock
    if (existing) {
      var updated = updateRow_(ss, existing, lead, fields);
      if (updated) return updated;
      // Row was deleted or shifted (manual sheet cleanup) — fall through and
      // write the lead as a fresh row instead of overwriting a stranger's row.
    }
    var ws = ensureEventTab_(ss, eventName);
    migrateTab_(ws);
    var row = firstEmptyRow_(ws);
    var out = new Array(HEADERS.length);
    for (var i = 0; i < out.length; i++) out[i] = "";
    out[COL.first] = fields.first_name || "";
    out[COL.last] = fields.last_name || "";
    out[COL.nativeFirst] = fields.native_first_name || "";
    out[COL.nativeLast] = fields.native_last_name || "";
    out[COL.company] = fields.company || "";
    out[COL.title] = fields.title || "";
    out[COL.email] = fields.email || "";
    out[COL.phone] = fields.phone || "";
    out[COL.mobile] = fields.mobile || "";
    out[COL.city] = fields.city || "";
    out[COL.country] = fields.country || "";
    out[COL.leadSource] = LEAD_SOURCE;
    out[COL.notes] = composeNotes_(lead, fields);
    out[COL.linkedin] = fields.linkedin || "";
    out[COL.event] = ws.getName();
    out[COL.capturedBy] = lead.rep || "";
    out[COL.capturedAt] = lead.capturedAt || new Date().toISOString();
    out[COL.temperature] = lead.temperature || "";
    out[COL.followUp] = lead.followUp || "";
    out[COL.push] = false;
    out[COL.badgePhoto] = photoUrl;
    out[COL.leadType] = lead.leadType || "";
    // State / Company URL stay blank — enrichment fills them at push time.
    ws.getRange(row, 1, 1, HEADERS.length).setValues([out]);
    upsertLedger_(sync, req.uuid, ws.getName(), row, lead.repEmail || "");
    return json_({ ok: true, row: row, event: ws.getName(), fields: publicFields_(fields) });
  } finally {
    lock.releaseLock();
  }
}

function anthropicRomanize_(first, last, company) {
  var body = JSON.parse(handleRomanize_({ first: first, last: last, company: company }).getContent());
  if (!body.ok) throw new Error(body.error || "romanize failed");
  return body.fields;
}

// Later edits from the app update the same row. Non-empty incoming values win;
// empty incoming values never blank out data already in the sheet. Review-owned
// columns (Push?, HubSpot Status, Badge Photo) are untouched.
// Returns null when the ledger row no longer holds this lead (deleted/shifted
// by manual sheet cleanup) so the caller recreates it instead.
function updateRow_(ss, existing, lead, fields) {
  var ws = ss.getSheetByName(existing.tab);
  if (!ws) return null;
  migrateTab_(ws);
  var row = existing.row;
  var cur = ws.getRange(row, 1, 1, HEADERS.length).getValues()[0];
  var rowEmpty = cur.every(function (c) { return c === "" || c === false; });
  if (rowEmpty || !sameCapture_(cur[COL.capturedAt], lead.capturedAt)) return null;
  var pick = function (v, idx) { return v || cur[idx]; };
  var merged = {
    first_name: pick(fields.first_name, COL.first),
    last_name: pick(fields.last_name, COL.last),
    native_first_name: pick(fields.native_first_name, COL.nativeFirst),
    native_last_name: pick(fields.native_last_name, COL.nativeLast),
    company: pick(fields.company, COL.company),
    title: pick(fields.title, COL.title),
    email: pick(fields.email, COL.email),
    phone: pick(fields.phone, COL.phone),
    mobile: pick(fields.mobile, COL.mobile),
    city: pick(fields.city, COL.city),
    country: pick(fields.country, COL.country),
    linkedin: pick(fields.linkedin, COL.linkedin)
  };
  // Contiguous block A–I (name → mobile).
  ws.getRange(row, 1, 1, 9).setValues([[
    merged.first_name, merged.last_name, merged.native_first_name, merged.native_last_name,
    merged.company, merged.title, merged.email, merged.phone, merged.mobile
  ]]);
  ws.getRange(row, COL.city + 1).setValue(merged.city);
  ws.getRange(row, COL.country + 1).setValue(merged.country);
  ws.getRange(row, COL.notes + 1).setValue(composeNotes_(lead, fields));
  ws.getRange(row, COL.linkedin + 1).setValue(merged.linkedin);
  ws.getRange(row, COL.temperature + 1, 1, 2).setValues([[
    lead.temperature || cur[COL.temperature], lead.followUp || cur[COL.followUp]
  ]]);
  // Lead Type is rep-editable; State / Company URL are enrichment-owned, never touched here.
  ws.getRange(row, COL.leadType + 1).setValue(lead.leadType || cur[COL.leadType]);
  return json_({ ok: true, row: row, event: existing.tab, updated: true, fields: merged });
}

// Identity check for updates: the row's Captured At must match the lead's.
// Sheets may auto-parse ISO strings into Dates, so compare as timestamps with
// a small tolerance; fall back to string equality; unknown → not the same row.
function sameCapture_(cellValue, capturedAt) {
  if (!capturedAt) return false;
  if (String(cellValue) === String(capturedAt)) return true;
  var a = new Date(cellValue).getTime(), b = new Date(capturedAt).getTime();
  if (isNaN(a) || isNaN(b)) return false;
  return Math.abs(a - b) < 5000;
}

// Keep one ledger row per uuid: update the existing entry's tab/row if present.
function upsertLedger_(sync, uuid, tab, row, repEmail) {
  var last = sync.getLastRow();
  if (last > 0) {
    var uuids = sync.getRange(1, 1, last, 1).getValues();
    for (var i = 0; i < uuids.length; i++) {
      if (uuids[i][0] === uuid) {
        sync.getRange(i + 1, 2, 1, 3).setValues([[new Date().toISOString(), tab, row]]);
        return;
      }
    }
  }
  sync.appendRow([uuid, new Date().toISOString(), tab, row, repEmail]);
}

// The upload template has one Notes column, so the rep note carries the extras.
function composeNotes_(lead, fields) {
  var parts = [];
  if (lead.note) parts.push(lead.note);
  if (fields.native_company) parts.push("native-company:" + fields.native_company);
  if (fields.language && fields.language !== "english") parts.push("badge-language:" + fields.language);
  if (lead.badgeId) parts.push("badge-id:" + lead.badgeId);
  if (fields.extractError) parts.push("(photo not readable — see Badge Photo column)");
  return parts.join(" | ");
}

function publicFields_(fields) {
  return {
    first_name: fields.first_name || "", last_name: fields.last_name || "",
    native_first_name: fields.native_first_name || "", native_last_name: fields.native_last_name || "",
    title: fields.title || "", company: fields.company || "",
    email: fields.email || "", phone: fields.phone || "", mobile: fields.mobile || "",
    city: fields.city || "", country: fields.country || "",
    linkedin: fields.linkedin || ""
  };
}

// True when the string has no CJK / Thai / Korean / Devanagari characters worth
// preserving separately — used to decide whether a company name is already Latin.
function isLatin_(s) {
  return !/[฀-๿぀-ヿ㐀-䶿一-鿿가-힯ऀ-ॿ]/.test(String(s || ""));
}

function savePhotoToDrive_(uuid, photoBase64) {
  var it = DriveApp.getFoldersByName(PHOTO_FOLDER);
  var folder = it.hasNext() ? it.next() : DriveApp.createFolder(PHOTO_FOLDER);
  var blob = Utilities.newBlob(Utilities.base64Decode(photoBase64), "image/jpeg", uuid + ".jpg");
  return folder.createFile(blob).getUrl();
}

// ---------- sheet plumbing ----------

// Reuse an existing tab — exact, case-insensitive, or fuzzy ("QB2 Tokyo" and
// "q2b tokyo" both map to "Q2B Tokyo") — or create one by copying TEMPLATE if
// present. Callers must hold the lock.
function ensureEventTab_(ss, name) {
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    if (RESERVED_TABS.indexOf(sheets[i].getName()) !== -1) continue;
    if (sameEvent_(sheets[i].getName(), name)) return sheets[i];
  }
  var tpl = ss.getSheetByName("TEMPLATE");
  if (tpl) {
    var ws = tpl.copyTo(ss);
    ws.setName(name);
    ws.showSheet();
    return ws;
  }
  var fresh = ss.insertSheet(name);
  fresh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight("bold");
  fresh.getRange(2, PUSH_COL, 199, 1) // Push? checkboxes, rows 2-200 like setup_sheet_apac.py
    .setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build());
  fresh.setFrozenRows(1);
  return fresh;
}

// Bring a tab up to the 26-column APAC schema. Tabs here are always created from
// TEMPLATE or by this script, so this only ever has to append missing trailing
// headers — it never inserts or reorders columns (that would break Push? and the
// upload template's A–O block). Safe to call repeatedly.
function migrateTab_(ws) {
  var width = Math.max(ws.getLastColumn(), 1);
  var head = ws.getRange(1, 1, 1, width).getValues()[0];
  for (var c = 1; c <= HEADERS.length; c++) {
    if (head[c - 1] !== HEADERS[c - 1]) {
      ws.getRange(1, c).setValue(HEADERS[c - 1]).setFontWeight("bold");
    }
  }
}

// Never appendRow on event tabs: checkbox validation makes appends jump past
// the validated range (the row-2001 bug, see setup_sheet.py).
function firstEmptyRow_(ws) {
  var values = ws.getRange(2, 1, Math.max(ws.getLastRow(), 2), HEADERS.length).getValues();
  for (var i = 0; i < values.length; i++) {
    var empty = values[i].every(function (c) { return c === "" || c === false; });
    if (empty) return i + 2;
  }
  return values.length + 2;
}

// _sync ledger: uuid | timestamp | event tab | row | rep email
function findUuid_(sync, uuid) {
  var last = sync.getLastRow();
  if (last < 1) return null;
  var rows = sync.getRange(1, 1, last, 4).getValues();
  for (var i = 0; i < rows.length; i++) {
    if (rows[i][0] === uuid) return { tab: String(rows[i][2]), row: Number(rows[i][3]) };
  }
  return null;
}

function ensureInfraTabs_(ss) {
  if (!ss.getSheetByName("Config")) {
    var cfg = ss.insertSheet("Config");
    cfg.getRange("A1").setValue("Rep Name (must match rep_map.json)");
    cfg.getRange("A2").setValue("Matan Wisebitan");
  }
  if (!ss.getSheetByName("_sync")) {
    ss.insertSheet("_sync").hideSheet();
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// Strip characters Sheets rejects in tab names. Non-Latin event names are fine —
// an APAC event tab may legitimately be named in Japanese or Thai.
function sanitizeEventName_(name) {
  return String(name || "").replace(/[\[\]\*\/\\\?:]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
}

// Fuzzy event-name equality: case/spacing/punctuation-insensitive, and up to
// 2 edits apart ("QB2 Tokyo" ≈ "Q2B Tokyo") — but names whose DIGITS differ
// are always different events ("Q2B 2025" vs "Q2B 2026"), and names in a native
// script must match exactly (see below).
function sameEvent_(a, b) {
  var na = normEvent_(a), nb = normEvent_(b);
  if (na === nb) return true;
  if (na.replace(/[^0-9]/g, "") !== nb.replace(/[^0-9]/g, "")) return false;
  // Fuzzy matching is for Latin typos only. A CJK/Thai name packs a word into each
  // character, so "量子大会 2026" and "量子展示 2026" are 2 edits apart yet different
  // events — those must match exactly.
  if (!isLatin_(na) || !isLatin_(nb)) return false;
  if (Math.min(na.length, nb.length) < 5) return false;
  return levenshtein_(na, nb) <= 2;
}
function normEvent_(s) {
  // Keep letters/digits in any script — \W would delete CJK/Thai entirely and make
  // every non-Latin event name collide with every other one.
  return String(s || "").toLowerCase().replace(/[\s\-_.,'"()\[\]/\\|!?&+:;]/g, "");
}
function levenshtein_(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 99;
  var prev = [];
  for (var j = 0; j <= b.length; j++) prev[j] = j;
  for (var i = 1; i <= a.length; i++) {
    var cur = [i];
    for (var k = 1; k <= b.length; k++) {
      cur[k] = Math.min(prev[k] + 1, cur[k - 1] + 1, prev[k - 1] + (a[i - 1] === b[k - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

// Run this once from the editor (▶) to trigger the FULL Drive permission prompt
// (a read-only call makes Google grant only drive.readonly, which isn't enough
// to save badge photos). Also pre-creates the photos folder.
function authorizeDrive() {
  var it = DriveApp.getFoldersByName(PHOTO_FOLDER);
  if (!it.hasNext()) DriveApp.createFolder(PHOTO_FOLDER);
}
