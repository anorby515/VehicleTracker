/**
 * Pure derivations behind the bootstrap. Input: the normalized data object
 * from Model.js (`D`) and today's date ("YYYY-MM-DD", America/Chicago).
 * Output: plain objects shaped like web/src/api/types.ts. Nothing here calls
 * an Apps Script service, so all of it runs in the Node tests.
 *
 * The rules are the ones in docs/API.md, "How the vehicle-wide values are
 * derived". The Sheet's own numbers (Schedule due dates and statuses,
 * Est. Current Mileage, Avg Miles/Day, Latest Odometer) pass straight through
 * and are never recalculated.
 */

// ---------------------------------------------------------------- display formatting

const MONTH_NAMES_ = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-12-25" → "Dec 25, 2026". */
function fmtDate_(ymd) {
  const md = fmtMonthDay_(ymd);
  return md ? md + ', ' + String(ymd).slice(0, 4) : '';
}

/** "2026-12-25" → "Dec 25". */
function fmtMonthDay_(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  return m ? MONTH_NAMES_[+m[2] - 1] + ' ' + (+m[3]) : '';
}

function withCommas_(digits) {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 40000 → "40,000". */
function fmtMiles_(n) {
  const r = Math.round(n);
  return (r < 0 ? '-' : '') + withCommas_(String(Math.abs(r)));
}

/** 1518.98 → "$1,518.98". */
function fmtMoney_(n) {
  const parts = Math.abs(n).toFixed(2).split('.');
  return (n < 0 ? '-' : '') + '$' + withCommas_(parts[0]) + '.' + parts[1];
}

/** Money is summed in whole cents so totals never pick up float noise. */
function cents_(n) {
  return Math.round(n * 100);
}

/** Sheets ROUND(x, 0): halves round away from zero (Math.round rounds -2.5 to -2). */
function roundHalfAway_(x) {
  return x < 0 ? -Math.round(-x) : Math.round(x);
}

// ---------------------------------------------------------------- vehicles

function activeVehicles_(vehicles) {
  return (vehicles || []).filter(v => v.active);
}

/** Rows of any tab that belong to one vehicle (Vehicle is the key everywhere). */
function rowsFor_(rows, vehicleName) {
  return (rows || []).filter(r => r.vehicle === vehicleName);
}

/** Model words too generic to stand alone ("Grand" Cherokee, "Model" Y, "Range" Rover). */
const GENERIC_MODEL_WORDS_ = ['grand', 'model', 'new', 'range', 'land', 'santa', 'town', 'crown', 'super', 'the'];

/**
 * Short name for tight spots: the Model's first word ("4Runner", "X7",
 * "Telluride" from "Telluride SX Prestige"), or its first two words when the
 * first is generic or a single character ("Grand Cherokee", "3 Series").
 */
function shortName_(v) {
  const model = asStr_(v && v.model);
  if (model) {
    const words = model.split(/\s+/);
    const first = words[0];
    if (words.length > 1 && (first.length < 2 || GENERIC_MODEL_WORDS_.indexOf(first.toLowerCase()) !== -1)) {
      return first + ' ' + words[1];
    }
    return first;
  }
  return asStr_(v && v.make) || asStr_(v && v.name) || '';
}

/** Short name for a vehicle name; falls back to the name itself when unknown. */
function shortNameFor_(vehicleName, D) {
  const row = ((D && D.vehicles) || []).filter(v => v.name === vehicleName)[0];
  return row ? shortName_(row) : vehicleName;
}

/** True when the user's Driver Name (fallback Name) matches Primary Driver, ignoring case. */
function isDriverOf_(vehicle, user) {
  const driver = lower_(vehicle && vehicle.primaryDriver);
  const me = lower_(user && (user.driverName || user.name));
  return driver !== '' && driver === me;
}

/**
 * The vehicle's latest odometer. Before setupSchemaApply() adds the Latest
 * Odometer columns, falls back to Last Known Mileage / Last Visit Date.
 */
function latestOdometerOf_(v) {
  if (v.latestOdometer !== null) return { mileage: v.latestOdometer, date: v.latestOdometerDate };
  return { mileage: v.lastKnownMileage, date: v.lastVisitDate };
}

/** Date the vehicle reaches `miles` from Est. Current Mileage and Avg Miles/Day, or null. */
function dateForMiles_(miles, v, today) {
  if (miles === null || v.estMileage === null || !(v.avgMilesPerDay > 0)) return null;
  return addDays_(today, roundHalfAway_((miles - v.estMileage) / v.avgMilesPerDay));
}

/** Newest date with mileage evidence: a visit with mileage or an odometer reading. */
function lastMileageEvidenceDate_(v, D, today) {
  let best = null;
  const consider = r => {
    if (r.mileage === null || !r.date || r.date > today) return;
    if (!best || r.date > best) best = r.date;
  };
  rowsFor_(D.visits, v.name).forEach(consider);
  rowsFor_(D.odometer, v.name).forEach(consider);
  return best;
}

/** Odometer nudge condition (spec 8.4): no mileage evidence in the last ODOMETER_NUDGE_DAYS. */
function needsOdometerNudge_(vehicleView, today) {
  const d = vehicleView.lastMileageEvidenceDate;
  return !d || daysBetween_(d, today) > RULES.ODOMETER_NUDGE_DAYS;
}

// ---------------------------------------------------------------- service types

/** The catch-all types never win a text match. */
const CATCH_ALL_SERVICE_TYPES_ = ['other', 'unknown'];

/**
 * Normalizes text for whole-word matching: lower case, "&" → "and",
 * punctuation → spaces, and a trailing plural "s" dropped from each word
 * ("Tires" and "tire", "brake pads" and "brake pad" match each other).
 */
function matchWords_(s) {
  return String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim()
    .split(' ').filter(Boolean)
    .map(w => (w.length > 3 && /[^s]s$/.test(w) ? w.slice(0, -1) : w))
    .join(' ');
}

/**
 * Item text → canonical Service Type, matched against each type's name and
 * its Receipt Synonyms as whole words, ignoring case. The longest matching
 * phrase wins (ties go to the earlier Service Types row). "Other" and
 * "Unknown" are ignored. Returns null when nothing matches.
 */
function matchServiceType_(text, serviceTypes) {
  const hay = ' ' + matchWords_(text) + ' ';
  if (hay.trim() === '') return null;
  let best = null, bestLen = 0;
  (serviceTypes || []).forEach(t => {
    if (CATCH_ALL_SERVICE_TYPES_.indexOf(lower_(t.name)) !== -1) return;
    [t.name].concat(t.synonyms || []).forEach(phrase => {
      const p = matchWords_(phrase);
      if (p && p.length > bestLen && hay.indexOf(' ' + p + ' ') !== -1) {
        best = t.name;
        bestLen = p.length;
      }
    });
  });
  return best;
}

// ---------------------------------------------------------------- coverage (spec 8.3)

/** Covers cell → service types, or ['All'] when any entry is "All". Blank → []. */
function parseCovers_(text) {
  const list = splitList_(text);
  if (list.some(x => x.toLowerCase() === VALUES.COVERS_ALL)) return ['All'];
  return list;
}

/** Warranties and prepaid plans for one vehicle, active and expired, in tab order. */
function buildCoverage_(v, warranties, today) {
  return rowsFor_(warranties, v.name).map(w => coveragePlan_(w, v, today));
}

function coveragePlan_(w, v, today) {
  const endMilesDate = dateForMiles_(w.endMiles, v, today);
  let endsOn = null, endsBy = null;
  if (w.endDate && (!endMilesDate || w.endDate <= endMilesDate)) {
    endsOn = w.endDate;
    endsBy = 'date';
  } else if (endMilesDate) {
    endsOn = endMilesDate;
    endsBy = 'miles';
  }
  // Active: before the End Date and below the End Miles. Blank limits don't
  // count, and neither does End Miles when there is no mileage estimate.
  const beforeEnd = !w.endDate || today < w.endDate;
  const belowMiles = w.endMiles === null || v.estMileage === null || v.estMileage < w.endMiles;
  return {
    name: w.name,
    type: w.type,
    startDate: w.startDate,
    endDate: w.endDate,
    startMiles: w.startMiles,
    endMiles: w.endMiles,
    endMilesDate: endMilesDate,
    endsOn: endsOn,
    endsBy: endsBy,
    covers: parseCovers_(w.coversText),
    active: beforeEnd && belowMiles,
    notes: w.notes,
  };
}

/**
 * Names of the active plans that cover a service type (Covers lists it, or is
 * All). Rows without a service type (dealer, registration, recall, warranty,
 * unmatched recommendations) are never "covered".
 */
function coveredBy_(serviceType, plans) {
  if (!serviceType) return [];
  const st = serviceType.toLowerCase();
  return (plans || []).filter(p => p.active && p.covers.some(c => {
    const l = c.toLowerCase();
    return l === VALUES.COVERS_ALL || l === st;
  })).map(p => p.name);
}

// ---------------------------------------------------------------- upcoming (spec 6.2)

/**
 * Upcoming rows for one vehicle: Schedule, dealer's next service, open/watch
 * recommendations, warranties ending soon, registration and new recalls.
 * Schedule rows with Status "No history" go to `noHistory` (tab order).
 * @param {object[]} [coverage] buildCoverage_ output, when already built
 * @return {{upcoming: object[], noHistory: object[]}}
 */
function buildUpcoming_(v, D, today, coverage) {
  const plans = coverage || buildCoverage_(v, D.warranties, today);
  const upcoming = [], noHistory = [];
  const services = rowsFor_(D.visitServices, v.name);

  rowsFor_(D.schedule, v.name).forEach(s => {
    if (!s.serviceType) return;
    const item = scheduleItem_(s, v, services);
    (item.status === 'No history' ? noHistory : upcoming).push(item);
  });
  const dealer = dealerItem_(v, today);
  if (dealer) upcoming.push(dealer);
  rowsFor_(D.recommendations, v.name).forEach(r => {
    const item = recommendationItem_(r, v, D.serviceTypes);
    if (item) upcoming.push(item);
  });
  plans.forEach(p => {
    const item = warrantyItem_(p, v, today);
    if (item) upcoming.push(item);
  });
  const reg = registrationItem_(v, today);
  if (reg) upcoming.push(reg);
  rowsFor_(D.recalls, v.name).forEach(r => {
    if (lower_(r.status) === VALUES.RECALL_NEW) upcoming.push(recallItem_(r, v));
  });

  upcoming.concat(noHistory).forEach(item => { item.coveredBy = coveredBy_(item.serviceType, plans); });
  upcoming.sort(compareUpcoming_);
  return { upcoming: upcoming, noHistory: noHistory };
}

/** Schedule › Status as a badge word. Unknown or blank: No history when undated, else OK. */
function scheduleStatus_(s) {
  const l = lower_(s.status);
  if (l === VALUES.SCHEDULE_NO_HISTORY) return 'No history';
  if (l === 'overdue') return 'Overdue';
  if (l === 'due soon') return 'Due soon';
  if (l === 'ok') return 'OK';
  return s.dueBy ? 'OK' : 'No history';
}

function scheduleItem_(s, v, services) {
  return {
    id: 'schedule:' + v.name + ':' + s.serviceType,
    kind: 'schedule',
    title: s.serviceType,
    subtitle: null,
    dueBy: s.dueBy,
    dueMiles: s.nextDueMiles,
    status: scheduleStatus_(s),
    serviceType: s.serviceType,
    coveredBy: [],
    schedule: {
      intervalMonths: s.intervalMonths,
      intervalMiles: s.intervalMiles,
      intervalSource: s.intervalSource,
      lastDoneDate: s.lastDoneDate,
      lastDoneMiles: s.lastDoneMiles,
      lastDoneVisitId: lastDoneVisitId_(s, services),
      nextDueDate: s.nextDueDate,
      nextDueMiles: s.nextDueMiles,
      estDateForMiles: s.estDateForMiles,
      sheetStatus: s.status,
    },
  };
}

/**
 * Visit that last did a scheduled service: the Visit Services row with the
 * same Service Type, Date = Last Done Date and Mileage = Last Done Miles;
 * failing that, the same Date only. (The Sheet takes the latest date and the
 * highest mileage separately, so they can come from different rows.)
 */
function lastDoneVisitId_(s, services) {
  if (!s.lastDoneDate) return null;
  const type = lower_(s.serviceType);
  const sameDay = services.filter(r => r.visitId && r.date === s.lastDoneDate && lower_(r.serviceType) === type);
  const exact = sameDay.filter(r => r.mileage === s.lastDoneMiles);
  const hit = exact[0] || sameDay[0];
  return hit ? hit.visitId : null;
}

/**
 * Dealer's next service from Vehicles › Dealer Next Due Date / Miles.
 * Hidden when the date is more than DEALER_PAST_GRACE_DAYS past or, with only
 * miles, when the estimate is past them by more than that many days' driving.
 * dueBy is the earlier of the date and the day the miles are reached.
 */
function dealerItem_(v, today) {
  const date = v.dealerNextDueDate, miles = v.dealerNextDueMiles;
  if (!date && miles === null) return null;
  const est = v.estMileage, avg = v.avgMilesPerDay;
  if (date) {
    if (daysBetween_(date, today) > RULES.DEALER_PAST_GRACE_DAYS) return null;
  } else if (est !== null && avg > 0 && est - miles > RULES.DEALER_PAST_GRACE_DAYS * avg) {
    return null;
  }
  const milesDate = dateForMiles_(miles, v, today);
  const dueBy = !date ? milesDate : !milesDate ? date : (milesDate < date ? milesDate : date);
  const reached = miles !== null && est !== null && est >= miles;
  let status = 'OK';
  if ((dueBy && dueBy < today) || reached) status = 'Overdue';
  else if (dueBy && daysBetween_(today, dueBy) <= RULES.DUE_SOON_DAYS) status = 'Due soon';
  const said = [date ? fmtDate_(date) : null, miles !== null ? fmtMiles_(miles) + ' mi' : null].filter(Boolean);
  return {
    id: 'dealer:' + v.name + ':next',
    kind: 'dealer',
    title: "Dealer's next service",
    subtitle: 'Dealer suggested ' + said.join(' or '),
    dueBy: dueBy,
    dueMiles: miles,
    status: status,
    serviceType: null,
    coveredBy: [],
  };
}

/** Open → "Declined at last visit" (+ estimate); Watch → "Keep an eye on". Others → null. */
function recommendationItem_(r, v, serviceTypes) {
  const st = lower_(r.status);
  if (st !== VALUES.REC_OPEN && st !== VALUES.REC_WATCH) return null;
  const open = st === VALUES.REC_OPEN;
  return {
    id: 'recommendation:' + v.name + ':' + r.recId,
    kind: 'recommendation',
    title: r.item || 'Shop recommendation',
    subtitle: open
      ? 'Declined at last visit' + (r.estimate !== null ? ' · ' + fmtMoney_(r.estimate) : '')
      : 'Keep an eye on',
    dueBy: null,
    dueMiles: null,
    status: open ? 'Declined' : 'Watch',
    serviceType: matchServiceType_(r.item, serviceTypes),
    coveredBy: [],
    recommendation: {
      recId: r.recId,
      status: open ? 'Open' : 'Watch',
      estimate: r.estimate,
      visitId: r.visitId,
      date: r.date,
      mileage: r.mileage,
    },
  };
}

/** An active plan whose endsOn falls within the next WARRANTY_WINDOW_DAYS. */
function warrantyItem_(p, v, today) {
  if (!p.active || !p.endsOn) return null;
  const days = daysBetween_(today, p.endsOn);
  if (days < 0 || days > RULES.WARRANTY_WINDOW_DAYS) return null;
  return {
    id: 'warranty:' + v.name + ':' + p.name,
    kind: 'warranty',
    title: p.name + ' ends',
    subtitle: p.type,
    dueBy: p.endsOn,
    dueMiles: p.endMiles,
    status: days <= RULES.DUE_SOON_DAYS ? 'Due soon' : 'OK',
    serviceType: null,
    coveredBy: [],
    warranty: { name: p.name, endsBy: p.endsBy },
  };
}

/** Registration expiring within REGISTRATION_WINDOW_DAYS (or already expired). */
function registrationItem_(v, today) {
  if (!v.registrationExpires) return null;
  const days = daysBetween_(today, v.registrationExpires);
  if (days > RULES.REGISTRATION_WINDOW_DAYS) return null;
  return {
    id: 'registration:' + v.name + ':' + v.registrationExpires,
    kind: 'registration',
    title: 'Registration renewal',
    subtitle: days < 0 ? 'Expired' : null,
    dueBy: v.registrationExpires,
    dueMiles: null,
    status: days < 0 ? 'Overdue' : days <= RULES.DUE_SOON_DAYS ? 'Due soon' : 'OK',
    serviceType: null,
    coveredBy: [],
  };
}

/** NHTSA components are upper case and colon-separated: "AIR BAGS:FRONTAL" → "Air bags". */
function recallTitle_(r) {
  const c = (r.component || '').split(':')[0].trim().toLowerCase();
  return c ? 'Recall: ' + c.charAt(0).toUpperCase() + c.slice(1) : 'Recall ' + r.campaignNumber;
}

function recallItem_(r, v) {
  return {
    id: 'recall:' + v.name + ':' + r.campaignNumber,
    kind: 'recall',
    title: recallTitle_(r),
    subtitle: 'May apply to this model',
    dueBy: null,
    dueMiles: null,
    status: 'Recall',
    serviceType: null,
    coveredBy: [],
    recall: { campaignNumber: r.campaignNumber },
  };
}

/** Undated rows follow dated ones in this order. */
const UNDATED_ORDER_ = { 'Declined': 0, 'Recall': 1, 'Watch': 2 };

/** Overdue first; then by dueBy (undated last: Declined, Recall, Watch); ties by title. */
function compareUpcoming_(a, b) {
  const oa = a.status === 'Overdue' ? 0 : 1, ob = b.status === 'Overdue' ? 0 : 1;
  if (oa !== ob) return oa - ob;
  const c = compareYmd_(a.dueBy, b.dueBy);
  if (c) return c;
  if (!a.dueBy) {
    const ua = a.status in UNDATED_ORDER_ ? UNDATED_ORDER_[a.status] : 3;
    const ub = b.status in UNDATED_ORDER_ ? UNDATED_ORDER_[b.status] : 3;
    if (ua !== ub) return ua - ub;
  }
  const ta = String(a.title || '').toLowerCase(), tb = String(b.title || '').toLowerCase();
  return ta < tb ? -1 : ta > tb ? 1 : 0;
}

// ---------------------------------------------------------------- service journal (spec 6.3)

/** Groups rows by Visit ID (rows without one are dropped). */
function groupByVisit_(rows) {
  const out = Object.create(null);
  rows.forEach(r => {
    if (!r.visitId) return;
    (out[r.visitId] = out[r.visitId] || []).push(r);
  });
  return out;
}

/** Newest first by Date, then Mileage; blanks last; ties keep tab order. */
function compareVisitsNewestFirst_(a, b) {
  if (a.date !== b.date) {
    if (!a.date) return 1;
    if (!b.date) return -1;
    return a.date < b.date ? 1 : -1;
  }
  if (a.mileage !== b.mileage) {
    if (a.mileage === null) return 1;
    if (b.mileage === null) return -1;
    return b.mileage - a.mileage;
  }
  return a._row - b._row;
}

function sourceTag_(source) {
  const s = lower_(source);
  if (s === 'carfax') return 'CarFax';
  if (s === 'owner-reported' || s === 'owner journal') return 'Owner';
  if (s === VALUES.SOURCE_PURCHASE) return 'Purchase';
  return null;
}

const IMAGE_EXTENSIONS_ = ['png', 'jpg', 'jpeg', 'gif', 'heic', 'heif', 'webp', 'tif', 'tiff', 'bmp'];

/** Guessed from the file name's extension. */
function documentKind_(fileName) {
  const m = /\.([a-z0-9]+)\s*$/i.exec(fileName || '');
  const ext = m ? m[1].toLowerCase() : '';
  if (ext === 'pdf') return 'pdf';
  return IMAGE_EXTENSIONS_.indexOf(ext) !== -1 ? 'image' : 'other';
}

/** PDFs first (a merged PDF before its page images), then images, then others; tab order within each. */
function documentRefs_(rows) {
  const rank = { pdf: 0, image: 1, other: 2 };
  return rows.filter(d => d.fileId)
    .map(d => ({
      documentType: d.documentType,
      fileName: d.fileName,
      fileId: d.fileId,
      pages: d.pages,
      complete: d.complete,
      notes: d.notes,
      kind: documentKind_(d.fileName),
      _row: d._row,
    }))
    .sort((a, b) => (rank[a.kind] - rank[b.kind]) || (a._row - b._row))
    .map(d => { delete d._row; return d; });
}

/** The vehicle's visits, newest first, each with its services, documents, recommendations and readings. */
function buildVisits_(v, D) {
  const services = groupByVisit_(rowsFor_(D.visitServices, v.name));
  const docs = groupByVisit_(rowsFor_(D.documents, v.name));
  const recs = groupByVisit_(rowsFor_(D.recommendations, v.name));
  const readings = groupByVisit_(rowsFor_(D.readings, v.name));
  return rowsFor_(D.visits, v.name).slice().sort(compareVisitsNewestFirst_).map(x => ({
    visitId: x.visitId,
    date: x.date,
    mileage: x.mileage,
    location: x.location,
    roNumber: x.roNumber,
    summary: x.summary,
    invoiceTotal: x.invoiceTotal,
    amountPaid: x.amountPaid,
    cardSurcharge: x.cardSurcharge,
    dealerNextDueDate: x.dealerNextDueDate,
    dealerNextDueMiles: x.dealerNextDueMiles,
    source: x.source,
    sourceTag: sourceTag_(x.source),
    beforeOwnership: !!(x.date && v.purchaseDate && x.date < v.purchaseDate),
    notes: x.notes,
    services: (services[x.visitId] || []).map(s => ({
      serviceType: s.serviceType,
      description: s.description,
      lineCost: s.lineCost,
      notes: s.notes,
    })),
    documents: documentRefs_(docs[x.visitId] || []),
    recommendations: (recs[x.visitId] || []).map(r => ({
      recId: r.recId,
      item: r.item,
      estimate: r.estimate,
      status: r.status,
      resolvedByVisit: r.resolvedByVisit,
      notes: r.notes,
    })),
    readings: (readings[x.visitId] || []).map(r => ({
      item: r.item,
      value: r.value,
      unit: r.unit,
      rating: r.rating,
    })),
  }));
}

// ---------------------------------------------------------------- costs (spec 8.6)

/**
 * Spend = Visits Invoice Total where Source isn't Purchase and Date is on or
 * after Purchase Date (every dated visit when Purchase Date is blank).
 * Visits without a Date can't be placed in time and are left out.
 */
function buildCosts_(v, D, today) {
  const thisYear = yearOf_(today);
  const yearAgo = addDays_(today, -365);
  const visits = rowsFor_(D.visits, v.name).filter(x =>
    x.date && lower_(x.source) !== VALUES.SOURCE_PURCHASE && (!v.purchaseDate || x.date >= v.purchaseDate));

  let total = 0, year = 0, last12 = 0, withoutTotal = 0;
  const byYear = {};
  const inSet = Object.create(null);
  visits.forEach(x => {
    inSet[x.visitId] = true;
    if (x.invoiceTotal === null) { withoutTotal++; return; }
    const c = cents_(x.invoiceTotal);
    const y = yearOf_(x.date);
    total += c;
    if (y === thisYear) year += c;
    if (x.date > yearAgo && x.date <= today) last12 += c;
    byYear[y] = (byYear[y] || 0) + c;
  });

  // One bar per year from the purchase year (or the first visit) to this year.
  let firstYear = v.purchaseDate ? yearOf_(v.purchaseDate) : thisYear;
  if (!v.purchaseDate) visits.forEach(x => { firstYear = Math.min(firstYear, yearOf_(x.date)); });
  const years = [];
  for (let y = Math.min(firstYear, thisYear); y <= thisYear; y++) years.push({ year: y, total: (byYear[y] || 0) / 100 });

  // Line Cost by Service Type for the same visits; zero totals are left out.
  const byType = {};
  rowsFor_(D.visitServices, v.name).forEach(s => {
    if (!s.visitId || !inSet[s.visitId] || s.lineCost === null) return;
    const t = s.serviceType || 'Other';
    byType[t] = (byType[t] || 0) + cents_(s.lineCost);
  });
  const types = Object.keys(byType).filter(t => byType[t] > 0)
    .sort((a, b) => (byType[b] - byType[a]) || (a < b ? -1 : a > b ? 1 : 0))
    .map(t => ({ serviceType: t, total: byType[t] / 100 }));

  const odo = latestOdometerOf_(v).mileage;
  const miles = odo !== null && v.purchaseMileage !== null ? odo - v.purchaseMileage : null;
  return {
    thisYear: year / 100,
    last12Months: last12 / 100,
    sincePurchase: total / 100,
    costPerMile: miles > 0 ? Math.round(total * 100 / miles) / 10000 : null, // dollars, 4 decimals
    visitsWithoutTotal: withoutTotal,
    byYear: years,
    byServiceType: types,
  };
}

// ---------------------------------------------------------------- wear (spec 8.7)

/**
 * Parses an Inspection Readings Item: "Tread — Left Front (outside edge)" →
 * {kind: 'tread', axle: 'front'}; "Brake Pad — Rear" → {kind: 'brake', axle: 'rear'}.
 * Anything else (tire pressure, battery) → null.
 */
function wearItemOf_(item) {
  const s = String(item || '').trim().toLowerCase();
  let kind = null;
  if (/^tread\b/.test(s)) kind = 'tread';
  else if (/^brake pads?\b/.test(s)) kind = 'brake';
  if (!kind) return null;
  const axle = /\bfront\b/.test(s) ? 'front' : /\brear\b/.test(s) ? 'rear' : null;
  return { kind: kind, axle: axle };
}

/**
 * Tire tread (lowest of all wheels per visit) and brake pads (lowest front
 * and lowest rear per visit), with a projection to the replacement point.
 */
function buildWear_(v, D, today) {
  const tread = [], front = [], rear = [];
  rowsFor_(D.readings, v.name).forEach(r => {
    if (r.value === null) return;
    const w = wearItemOf_(r.item);
    if (!w) return;
    if (w.kind === 'tread') tread.push(r);
    else if (w.axle === 'front') front.push(r);
    else if (w.axle === 'rear') rear.push(r);
    // A brake pad reading without Front or Rear can't be placed and is ignored.
  });
  return {
    tread: wearItem_('Tire tread', '/32 in', RULES.TREAD_REPLACE_32NDS, tread, v, today),
    brakeFront: wearItem_('Front brake pads', 'mm', RULES.BRAKE_PAD_REPLACE_MM, front, v, today),
    brakeRear: wearItem_('Rear brake pads', 'mm', RULES.BRAKE_PAD_REPLACE_MM, rear, v, today),
  };
}

function wearItem_(label, unit, replacementPoint, rows, v, today) {
  if (!rows.length) return null;
  // The lowest reading per visit is the series the chart draws.
  const byVisit = Object.create(null), order = [];
  rows.forEach(r => {
    const key = r.visitId || (r.date + '|' + r.mileage);
    const cur = byVisit[key];
    if (!cur) order.push(key);
    if (!cur || r.value < cur.value) {
      byVisit[key] = { value: r.value, date: r.date, mileage: r.mileage, rating: r.rating, visitId: r.visitId || '' };
    }
  });
  const series = order.map(k => byVisit[k]).sort((a, b) =>
    compareYmd_(a.date, b.date) || ((a.mileage === null ? Infinity : a.mileage) - (b.mileage === null ? Infinity : b.mileage)));

  // The current wear run starts after the last increase (a replacement resets it).
  let start = 0;
  for (let i = 1; i < series.length; i++) if (series[i].value > series[i - 1].value) start = i;
  const run = series.slice(start).filter(p => p.mileage !== null);
  const distinctMiles = run.map(p => p.mileage).filter((m, i, a) => a.indexOf(m) === i);

  let projection = null, note = null;
  if (distinctMiles.length < 2) {
    note = 'One reading so far';
  } else {
    const fit = leastSquares_(run.map(p => [p.mileage, p.value]));
    if (!(fit.slope < 0)) {
      note = 'Not wearing measurably yet';
    } else {
      const mileage = Math.round((replacementPoint - fit.intercept) / fit.slope);
      projection = { mileage: mileage, date: projectedDate_(mileage, series[series.length - 1], v, today) };
    }
  }
  const last = series[series.length - 1];
  return {
    label: label,
    unit: unit,
    replacementPoint: replacementPoint,
    latest: { value: last.value, date: last.date, mileage: last.mileage, rating: last.rating, visitId: last.visitId },
    readings: series.map(p => ({ value: p.value, date: p.date, mileage: p.mileage, visitId: p.visitId })),
    projection: projection,
    note: note,
  };
}

/** Least-squares line through [x, y] points: {slope, intercept}. */
function leastSquares_(points) {
  const n = points.length;
  let sx = 0, sy = 0;
  points.forEach(p => { sx += p[0]; sy += p[1]; });
  const mx = sx / n, my = sy / n;
  let sxy = 0, sxx = 0;
  points.forEach(p => { sxy += (p[0] - mx) * (p[1] - my); sxx += (p[0] - mx) * (p[0] - mx); });
  const slope = sxx === 0 ? 0 : sxy / sxx;
  return { slope: slope, intercept: my - slope * mx };
}

/**
 * Date a projected mileage is reached: from Est. Current Mileage like the
 * Schedule's Est. Date for Miles; without an estimate, from the latest
 * reading's date and mileage. Needs Avg Miles/Day.
 */
function projectedDate_(mileage, latest, v, today) {
  const viaEstimate = dateForMiles_(mileage, v, today);
  if (viaEstimate) return viaEstimate;
  if (!(v.avgMilesPerDay > 0) || !latest.date || latest.mileage === null) return null;
  return addDays_(latest.date, roundHalfAway_((mileage - latest.mileage) / v.avgMilesPerDay));
}

// ---------------------------------------------------------------- recalls (spec 8.9)

function compareYmdDesc_(a, b) {
  if (a === b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a > b ? -1 : 1;
}

/** All Recalls rows for the vehicle, newest Report Date first. */
function buildRecalls_(v, D) {
  return rowsFor_(D.recalls, v.name).slice()
    .sort((a, b) => compareYmdDesc_(a.reportDate, b.reportDate) || compareYmdDesc_(a.firstSeen, b.firstSeen) ||
      (a.campaignNumber < b.campaignNumber ? -1 : a.campaignNumber > b.campaignNumber ? 1 : 0))
    .map(r => ({
      campaignNumber: r.campaignNumber,
      reportDate: r.reportDate,
      component: r.component,
      summary: r.summary,
      consequence: r.consequence,
      remedy: r.remedy,
      status: r.status,
      firstSeen: r.firstSeen,
      notes: r.notes,
      parkIt: r.parkIt,
      parkOutside: r.parkOutside,
    }));
}

// ---------------------------------------------------------------- vehicle view

/**
 * One Vehicle (types.ts) without the per-user fields: isMine is false and
 * attention is empty until overlayUser_ fills them in.
 */
function buildVehicleView_(v, D, today) {
  const coverage = buildCoverage_(v, D.warranties, today);
  const up = buildUpcoming_(v, D, today, coverage);
  const odo = latestOdometerOf_(v);
  return {
    name: v.name,
    shortName: shortName_(v),
    year: v.year,
    make: v.make,
    model: v.model,
    vin: v.vin,
    plate: v.plate,
    primaryDriver: v.primaryDriver,
    isMine: false,
    photoFileId: v.photoFileId,
    originalInServiceDate: v.originalInServiceDate,
    purchaseDate: v.purchaseDate,
    purchaseMileage: v.purchaseMileage,
    estMileage: v.estMileage,
    avgMilesPerDay: v.avgMilesPerDay,
    latestOdometer: odo.mileage,
    latestOdometerDate: odo.date,
    lastMileageEvidenceDate: lastMileageEvidenceDate_(v, D, today),
    basics: {
      oilSpec: v.oilSpec,
      oilCapacity: v.oilCapacity,
      oilFilter: v.oilFilter,
      engineAirFilter: v.engineAirFilter,
      cabinAirFilter: v.cabinAirFilter,
      tireSize: v.tireSize,
      tirePressure: v.tirePressure,
      wiperFrontDriver: v.wiperFrontDriver,
      wiperFrontPassenger: v.wiperFrontPassenger,
      wiperRear: v.wiperRear,
      batteryGroup: v.batteryGroup,
    },
    registration: {
      expires: v.registrationExpires,
      fileId: v.registrationFileId,
      daysLeft: v.registrationExpires ? daysBetween_(today, v.registrationExpires) : null,
    },
    oemApp: v.oemAppName && safeAppLink_(v.oemAppLink, false)
      ? { name: v.oemAppName, link: safeAppLink_(v.oemAppLink, false), storeLink: safeAppLink_(v.oemAppStoreLink, true) }
      : null,
    upcoming: up.upcoming,
    noHistory: up.noHistory,
    coverage: coverage,
    visits: buildVisits_(v, D),
    costs: buildCosts_(v, D, today),
    wear: buildWear_(v, D, today),
    recalls: buildRecalls_(v, D),
    attention: [],
  };
}

/**
 * A link from the Sheet the app will navigate to (OEM App Link / Store
 * Link): an app URL scheme ("mybmw://") or a web link. Script-running and
 * local schemes (javascript:, data:, vbscript:, file:, blob:, about:) are
 * dropped, since the phone does `location.href = link`. With httpsOnly, only
 * https: links are kept. Anything unusable → null.
 */
function safeAppLink_(link, httpsOnly) {
  const s = asStr_(link);
  if (!s || s.length > 2048 || /[\s<>"]/.test(s)) return null;
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(s);
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  if (httpsOnly) return scheme === 'https' ? s : null;
  return ['javascript', 'data', 'vbscript', 'file', 'blob', 'about'].indexOf(scheme) === -1 ? s : null;
}

// ---------------------------------------------------------------- scans (spec 8.1)

const SCAN_KINDS_ = ['Receipt', 'Upload', 'Owner entry'];

/** App Scans › Status → one of SCAN_STATUS (case-insensitive); blank or unknown → Waiting. */
function scanStatus_(status) {
  const l = lower_(status);
  const keys = Object.keys(SCAN_STATUS);
  for (let i = 0; i < keys.length; i++) {
    if (SCAN_STATUS[keys[i]].toLowerCase() === l) return SCAN_STATUS[keys[i]];
  }
  return SCAN_STATUS.WAITING;
}

/** Vehicle a scan was filed under: from its visit, else from the Documents row with its file ID. */
function scanFiledVehicle_(row, D) {
  if (row.visitId) {
    const visit = (D.visits || []).filter(x => x.visitId === row.visitId)[0];
    if (visit) return visit.vehicle;
  }
  if (row.fileId) {
    const doc = (D.documents || []).filter(d => d.fileId === row.fileId)[0];
    if (doc) return doc.vehicle;
  }
  return null;
}

/** "Robert" → "Robert"; "the owner" → "The owner" at the start of a sentence. */
function capitalize_(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function scanStatusLabel_(status, shortName, ownerName) {
  switch (status) {
    case SCAN_STATUS.FILED: return shortName ? 'Filed on the ' + shortName : 'Filed';
    case SCAN_STATUS.ADDING: return 'Filed, adding to journal';
    case SCAN_STATUS.NEEDS_ATTENTION: return 'Needs attention';
    case SCAN_STATUS.CHECK_WITH_OWNER: return 'Check with ' + ownerName;
    default: return 'Waiting to be filed';
  }
}

function scanStatusDetail_(status, shortName, ownerName) {
  switch (status) {
    case SCAN_STATUS.FILED:
      return shortName ? "It's in the " + shortName + "'s service journal." : "It's in the service journal.";
    case SCAN_STATUS.ADDING:
      return (shortName ? "It's in the " + shortName + "'s folder" : "It's been filed") +
        ' and will show in the journal soon.';
    case SCAN_STATUS.NEEDS_ATTENTION:
      return capitalize_(ownerName) + "'s been notified. You may be asked to rescan.";
    case SCAN_STATUS.CHECK_WITH_OWNER:
      return "We couldn't tell where this scan went. " + capitalize_(ownerName) + ' can look into it.';
    default:
      return "It's in the pile. Receipts are usually filed within a few hours.";
  }
}

/**
 * App Scans row → Scan (types.ts). statusDetail is App Scans › Status Detail
 * when set, else a default for the status.
 */
function scanView_(row, D, ownerName) {
  const owner = ownerName || 'the owner';
  const status = scanStatus_(row.status);
  const filedVehicle = scanFiledVehicle_(row, D);
  const short = filedVehicle ? shortNameFor_(filedVehicle, D) : null;
  return {
    scanId: row.scanId,
    kind: SCAN_KINDS_.indexOf(row.kind) !== -1 ? row.kind : 'Receipt',
    vehicleHint: row.vehicleHint,
    fileId: row.fileId,
    fileName: row.fileName,
    pages: row.pages,
    uploadedAt: row.uploadedAt,
    status: status,
    statusLabel: scanStatusLabel_(status, short, owner),
    statusDetail: row.statusDetail || scanStatusDetail_(status, short, owner),
    visitId: row.visitId,
    filedVehicle: filedVehicle,
    lastChecked: row.lastChecked,
  };
}

// ---------------------------------------------------------------- attention banner (per user)

/**
 * Attention entries for one user on one vehicle, in banner order: scans that
 * need a rescan, new recalls, registration, odometer nudge.
 * @param {object} vehicleView buildVehicleView_ output
 * @param {object} user User (types.ts)
 * @param {object[]} scans the user's Scan views (myScans)
 */
function buildAttention_(vehicleView, user, scans, today) {
  const v = vehicleView;
  const route = '#/v/' + encodeURIComponent(v.name);
  const out = [];
  (scans || []).forEach(s => {
    if (s.status !== SCAN_STATUS.NEEDS_ATTENTION) return;
    if (s.vehicleHint !== v.name && s.filedVehicle !== v.name) return;
    const day = s.uploadedAt ? String(s.uploadedAt).slice(0, 10) : '';
    out.push({
      kind: 'rescan',
      text: 'A receipt you scanned' + (fmtMonthDay_(day) ? ' on ' + fmtMonthDay_(day) : '') + ' needs another look',
      href: '#/scans/' + encodeURIComponent(s.scanId),
    });
  });
  const newRecalls = v.recalls.filter(r => lower_(r.status) === VALUES.RECALL_NEW).length;
  if (newRecalls) {
    out.push({
      kind: 'recall',
      text: (newRecalls === 1 ? 'New recall may' : newRecalls + ' new recalls may') + ' apply to the ' + v.shortName,
      href: route + '/recalls',
    });
  }
  const days = v.registration.daysLeft;
  if (days !== null && days <= RULES.REGISTRATION_WINDOW_DAYS) {
    const when = fmtMonthDay_(v.registration.expires);
    out.push({
      kind: 'registration',
      text: days < 0 ? 'Registration expired ' + when : days === 0 ? 'Registration expires today' : 'Registration expires ' + when,
      href: route + '/registration',
    });
  }
  if (isDriverOf_(v, user) && needsOdometerNudge_(v, today)) {
    out.push({ kind: 'odometer', text: "What's the odometer on the " + v.shortName + '?', href: route + '/odometer' });
  }
  return out;
}
