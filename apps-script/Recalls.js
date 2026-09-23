/**
 * Recall lookup (spec 8.9; docs/DECISIONS.md "Recalls").
 *
 * The daily job asks NHTSA's public API about each active vehicle's make,
 * model and year (Vehicles › NHTSA Make, NHTSA Model, Year) and adds every
 * campaign it hasn't seen for that vehicle to the Recalls tab with Status
 * New. Notify.js then tells the primary driver and the owner.
 *
 * NHTSA facts (checked Sep 2026):
 * - GET https://api.nhtsa.gov/recalls/recallsByVehicle?make=&model=&modelYear=
 *   answers {Count, Message, results: [...]}.
 * - A model with no recalls comes back as HTTP 400 with a normal
 *   {"Count": 0, "results": []} body, which means "none".
 * - ReportReceivedDate is DD/MM/YYYY ("12/10/2023" is 12 Oct 2023), so it is
 *   parsed by hand, never with new Date().
 * - parkIt / parkOutSide (capital S) are optional booleans.
 *
 * Silent first import: a vehicle's first successful lookup adds its rows
 * without pushes, and logs each would-be notification on Notification Log as
 * "Silent (first import)" so it is never sent later. That covers the first
 * run and any car added later. A vehicle counts as imported once it has
 * Recalls rows or a successful lookup is recorded in the Script Property
 * RECALLS_CHECKED_VEHICLES (so a car with no recalls at first still gets a
 * push for its first real one).
 *
 * No top-level references to Config.js constants: Apps Script may load this
 * file before Config.js.
 */

/** Script Property: JSON list of vehicle names whose first lookup succeeded. */
const RECALLS_CHECKED_PROP_ = 'RECALLS_CHECKED_VEHICLES';

/** "12/10/2023" (DD/MM/YYYY) → "2023-10-12". Also accepts "YYYY-MM-DD". Anything else → null. */
function parseNhtsaDate_(s) {
  const str = String(s === null || s === undefined ? '' : s).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(str);
  let y, mo, d;
  if (m) {
    y = +m[1]; mo = +m[2]; d = +m[3];
  } else {
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(str);
    if (!m) return null;
    d = +m[1]; mo = +m[2]; y = +m[3];
  }
  if (mo < 1 || mo > 12 || d < 1 || d > new Date(Date.UTC(y, mo, 0)).getUTCDate()) return null;
  return y + '-' + pad2_(mo) + '-' + pad2_(d);
}

/** NHTSA flags arrive as booleans; tolerate "true"/"Yes" strings. Missing → false. */
function nhtsaFlag_(v) {
  return v === true || asYesNo_(v) === true;
}

/** Trimmed text, or '' (NHTSA fields can be null). */
function nhtsaText_(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}

/** Campaign numbers compare trimmed and upper-cased. */
function campaignKey_(c) {
  return nhtsaText_(c).toUpperCase();
}

/** One NHTSA result → a plain campaign, or null without a campaign number. Pure. */
function nhtsaCampaign_(r) {
  if (!r || typeof r !== 'object') return null;
  const campaignNumber = nhtsaText_(r.NHTSACampaignNumber);
  if (!campaignNumber) return null;
  return {
    campaignNumber: campaignNumber,
    reportDate: parseNhtsaDate_(r.ReportReceivedDate),
    component: nhtsaText_(r.Component),
    summary: nhtsaText_(r.Summary),
    consequence: nhtsaText_(r.Consequence),
    remedy: nhtsaText_(r.Remedy),
    notes: r.Notes === null || r.Notes === undefined ? null : nhtsaText_(r.Notes),
    parkIt: nhtsaFlag_(r.parkIt),
    parkOutside: nhtsaFlag_(r.parkOutSide) || nhtsaFlag_(r.parkOutside),
    modelYear: nhtsaText_(r.ModelYear),
  };
}

/**
 * The model's recall campaigns from NHTSA (not VIN-specific).
 * Accepts HTTP 200, and HTTP 400 whose body is NHTSA's JSON with a Count
 * (that's how it says "no recalls"). Anything else throws.
 * @return {object[]} nhtsaCampaign_ objects, one per campaign number
 */
function fetchRecalls_(make, model, year) {
  const url = NHTSA_RECALLS_URL + '?make=' + encodeURIComponent(make) + '&model=' + encodeURIComponent(model) +
    '&modelYear=' + encodeURIComponent(year);
  const res = UrlFetchApp.fetch(url, { method: 'get', muteHttpExceptions: true, headers: { Accept: 'application/json' } });
  const code = res.getResponseCode();
  let body = null;
  try { body = JSON.parse(res.getContentText()); } catch (e) { body = null; }
  const isNhtsa = body && typeof body === 'object' && !Array.isArray(body);
  const list = isNhtsa ? (Array.isArray(body.results) ? body.results : Array.isArray(body.Results) ? body.Results : null) : null;
  const ok = (code === 200 && isNhtsa && (list !== null || 'Count' in body)) ||
    (code === 400 && isNhtsa && 'Count' in body);
  if (!ok) {
    throw new Error('NHTSA recall lookup failed for ' + make + ' ' + model + ' ' + year + ': HTTP ' + code);
  }
  const seen = {};
  return (list || []).map(nhtsaCampaign_).filter(c => {
    if (!c || seen[campaignKey_(c.campaignNumber)]) return false;
    seen[campaignKey_(c.campaignNumber)] = true;
    return true;
  });
}

/** Text from outside goes into the Sheet as text, never as a formula (same rule as Sheet.js sheetSafe_). */
function sheetText_(s) {
  return sheetSafe_(s);
}

/** The Recalls row for a new campaign (Status New, First Seen today). */
function recallRowValues_(vehicleName, c, today) {
  return {
    'Vehicle': vehicleName,
    'Campaign Number': sheetText_(c.campaignNumber),
    'Report Date': c.reportDate ? noonDate_(c.reportDate) : '',
    'Component': sheetText_(c.component),
    'Summary': sheetText_(c.summary),
    'Consequence': sheetText_(c.consequence),
    'Remedy': sheetText_(c.remedy),
    'Status': 'New',
    'First Seen': noonDate_(today),
    'Notes': '',
    'Park It': c.parkIt ? 'Yes' : 'No',
    'Park Outside': c.parkOutside ? 'Yes' : 'No',
  };
}

function readRecallsChecked_() {
  try {
    const list = JSON.parse(prop_(RECALLS_CHECKED_PROP_, false) || '[]');
    const out = {};
    if (Array.isArray(list)) list.forEach(n => { out[String(n)] = true; });
    return out;
  } catch (e) {
    return {};
  }
}

function writeRecallsChecked_(checked) {
  PropertiesService.getScriptProperties().setProperty(RECALLS_CHECKED_PROP_, JSON.stringify(Object.keys(checked).sort()));
}

/**
 * The daily recall lookup. For each active vehicle with NHTSA Make, NHTSA
 * Model and Year, adds every campaign not yet on Recalls for that vehicle.
 * On a vehicle's first import, also logs its notifications as
 * "Silent (first import)" for the primary driver and the owner. One
 * vehicle's failure is logged and doesn't stop the others.
 * @param {Date} [now]
 * @param {{ownerEmail?: string}} [opts]
 * @return {{added: number, silent: number, errors: number, vehicles: object[]}}
 */
function runRecalls_(now, opts) {
  opts = opts || {};
  now = now || new Date();
  const today = nowParts_(now).ymd;
  const D = dataFromTabs_(readTabs_([TAB.VEHICLES, TAB.RECALLS, TAB.APP_USERS]));
  const ownerEmail = opts.ownerEmail !== undefined ? lower_(opts.ownerEmail) : ownerEmail_();
  const users = D.appUsers.filter(u => u.active);

  const known = {}; // vehicle → {CAMPAIGN: true}
  D.recalls.forEach(r => { (known[r.vehicle] = known[r.vehicle] || {})[campaignKey_(r.campaignNumber)] = true; });
  const checked = readRecallsChecked_();
  const checkedBefore = Object.keys(checked).length;

  const summary = { added: 0, silent: 0, errors: 0, vehicles: [] };
  activeVehicles_(D.vehicles).forEach(v => {
    if (!v.nhtsaMake || !v.nhtsaModel || !v.year) {
      console.log('Recalls: skipped ' + v.name + ' (NHTSA Make, NHTSA Model or Year is blank).');
      summary.vehicles.push({ vehicle: v.name, skipped: true });
      return;
    }
    try {
      const campaigns = fetchRecalls_(v.nhtsaMake, v.nhtsaModel, v.year);
      const have = known[v.name] || (known[v.name] = {});
      const firstImport = Object.keys(have).length === 0 && !checked[v.name];
      const fresh = campaigns.filter(c => !have[campaignKey_(c.campaignNumber)]);
      const recipients = firstImport ? notifyRecipients_(v, users, ownerEmail, true) : [];
      fresh.forEach(c => {
        appendAppRow_(TAB.RECALLS, recallRowValues_(v.name, c, today));
        have[campaignKey_(c.campaignNumber)] = true;
        summary.added++;
        if (!firstImport) return;
        const notice = recallNotice_(v.name, shortName_(v), c.campaignNumber, c.parkIt, c.parkOutside);
        recipients.forEach(email => {
          appendAppRow_(TAB.NOTIFICATION_LOG, {
            'Key': notice.key, 'Email': email, 'Title': notifyLogTitle_(notice), 'Sent At': now,
            'Result': NOTIFY_RESULT_.SILENT_FIRST_IMPORT,
          });
          summary.silent++;
        });
      });
      checked[v.name] = true;
      summary.vehicles.push({ vehicle: v.name, found: campaigns.length, added: fresh.length, firstImport: firstImport });
    } catch (e) {
      console.error('Recalls: ' + v.name + ' failed: ' + (e && e.message || e));
      summary.errors++;
      summary.vehicles.push({ vehicle: v.name, error: String(e && e.message || e) });
    }
  });

  if (Object.keys(checked).length !== checkedBefore) writeRecallsChecked_(checked);
  if (summary.added) invalidateBootstrapCache_();
  return summary;
}
