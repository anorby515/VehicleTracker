/**
 * Model: raw tabs (tabFromValues_ objects, see Sheet.js) → typed plain
 * objects. One normalizer per tab, plus a single-row version for each so
 * writers can normalize a row they just built.
 *
 * Columns are looked up by HEADER NAME. A missing column reads as blank, so
 * the app still works before setupSchemaApply() has added the new columns.
 * Blank cells become null (never ""). Every row keeps `_row`, its 1-based
 * Sheet row number, for writers that update in place.
 */

/**
 * The tabs loadData_() reads. A function rather than a constant, so this file
 * doesn't depend on Config.js having loaded first.
 */
function bootstrapTabNames_() {
  return [TAB.VEHICLES, TAB.VISITS, TAB.VISIT_SERVICES, TAB.DOCUMENTS, TAB.RECOMMENDATIONS,
    TAB.INSPECTION_READINGS, TAB.SCHEDULE, TAB.WARRANTIES, TAB.SERVICE_TYPES, TAB.ODOMETER_READINGS,
    TAB.APP_SCANS, TAB.RECALLS, TAB.APP_USERS];
}

/**
 * Reads every tab the bootstrap needs, once, and normalizes it.
 * @return {object} D: {vehicles, visits, visitServices, documents, recommendations,
 *   readings, schedule, warranties, serviceTypes, odometer, appScans, recalls, appUsers}
 */
function loadData_() {
  return dataFromTabs_(readTabs_(bootstrapTabNames_()));
}

/**
 * Pure version of loadData_: tabsByName maps tab name → tab object, or →
 * getValues()-style 2-D array (handy for fixtures). Missing tabs give [].
 */
function dataFromTabs_(tabsByName) {
  const src = tabsByName || {};
  const tab = name => {
    const t = src[name];
    if (!t) return null;
    return Array.isArray(t) ? tabFromValues_(name, t) : t;
  };
  return {
    vehicles: normVehicles_(tab(TAB.VEHICLES)),
    visits: normVisits_(tab(TAB.VISITS)),
    visitServices: normVisitServices_(tab(TAB.VISIT_SERVICES)),
    documents: normDocuments_(tab(TAB.DOCUMENTS)),
    recommendations: normRecommendations_(tab(TAB.RECOMMENDATIONS)),
    readings: normReadings_(tab(TAB.INSPECTION_READINGS)),
    schedule: normSchedule_(tab(TAB.SCHEDULE)),
    warranties: normWarranties_(tab(TAB.WARRANTIES)),
    serviceTypes: normServiceTypes_(tab(TAB.SERVICE_TYPES)),
    odometer: normOdometer_(tab(TAB.ODOMETER_READINGS)),
    appScans: normAppScans_(tab(TAB.APP_SCANS)),
    recalls: normRecalls_(tab(TAB.RECALLS)),
    appUsers: normAppUsers_(tab(TAB.APP_USERS)),
  };
}

/** Maps every row of a tab (null-safe) and drops rows the row function rejects. */
function normRows_(tab, fn) {
  if (!tab || !tab.rows) return [];
  return tab.rows.map(fn).filter(Boolean);
}

/** First present cell among alternative header spellings. */
function pick_(r, names) {
  for (let i = 0; i < names.length; i++) {
    if (names[i] in r) return r[names[i]];
  }
  return '';
}

/** "a, b ,, c" → ['a', 'b', 'c']. */
function splitList_(v) {
  const s = asStr_(v);
  if (!s) return [];
  return s.split(/[,;]/).map(x => x.trim()).filter(Boolean);
}

/** JSON cell → object; blank, bad JSON or a non-object → null. */
function parseJsonObject_(v) {
  const s = asStr_(v);
  if (!s) return null;
  try {
    const o = JSON.parse(s);
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------- journal tabs (read only)

function normVehicles_(tab) { return normRows_(tab, normVehicle_); }

function normVehicle_(r) {
  const name = asStr_(r['Vehicle']);
  if (!name) return null;
  return {
    _row: r._row,
    name: name,
    year: asInt_(r['Year']),
    make: asStr_(r['Make']),
    model: asStr_(r['Model']),
    vin: asStr_(r['VIN']),
    vinLast6: asStr_(r['VIN Last 6']),
    plate: asStr_(r['Plate']),
    primaryDriver: asStr_(r['Primary Driver']),
    active: lower_(r['Active']) === VALUES.ACTIVE_YES,
    driveFolderId: asStr_(r['Drive Folder ID']),
    originalInServiceDate: asYmd_(r['Original In-Service Date']),
    purchaseDate: asYmd_(r['Purchase Date']),
    purchaseMileage: asNum_(r['Purchase Mileage']),
    lastVisitDate: asYmd_(r['Last Visit Date']),
    lastKnownMileage: asNum_(r['Last Known Mileage']),
    avgMilesPerDay: asNum_(r['Avg Miles/Day']),
    estMileage: asNum_(r['Est. Current Mileage']),
    dealerNextDueDate: asYmd_(r['Dealer Next Due Date']),
    dealerNextDueMiles: asNum_(r['Dealer Next Due Miles']),
    notes: asStr_(r['Notes']),
    purchasePrice: asNum_(r['Purchase Price']),
    // Columns added by setupSchema (NEW_VEHICLE_COLUMNS).
    photoFileId: asStr_(r['Photo File ID']),
    oilSpec: asStr_(r['Oil Spec']),
    oilCapacity: asStr_(r['Oil Capacity']),
    oilFilter: asStr_(r['Oil Filter']),
    engineAirFilter: asStr_(r['Engine Air Filter']),
    cabinAirFilter: asStr_(r['Cabin Air Filter']),
    tireSize: asStr_(r['Tire Size']),
    tirePressure: asStr_(r['Tire Pressure']),
    wiperFrontDriver: asStr_(r['Wiper Front Driver']),
    wiperFrontPassenger: asStr_(r['Wiper Front Passenger']),
    wiperRear: asStr_(r['Wiper Rear']),
    batteryGroup: asStr_(r['Battery Group']),
    registrationExpires: asYmd_(r['Registration Expires']),
    registrationFileId: asStr_(r['Registration File ID']),
    nhtsaMake: asStr_(r['NHTSA Make']),
    nhtsaModel: asStr_(r['NHTSA Model']),
    oemAppName: asStr_(r['OEM App Name']),
    oemAppLink: asStr_(r['OEM App Link']),
    oemAppStoreLink: asStr_(r['OEM App Store Link']),
    latestOdometer: asNum_(r['Latest Odometer']),
    latestOdometerDate: asYmd_(r['Latest Odometer Date']),
  };
}

function normVisits_(tab) { return normRows_(tab, normVisit_); }

function normVisit_(r) {
  const visitId = asStr_(r['Visit ID']);
  const vehicle = asStr_(r['Vehicle']);
  if (!visitId || !vehicle) return null;
  return {
    _row: r._row,
    visitId: visitId,
    vehicle: vehicle,
    date: asYmd_(r['Date']),
    mileage: asNum_(r['Mileage']),
    location: asStr_(r['Location']),
    roNumber: asStr_(r['RO #']),
    summary: asStr_(r['Summary']),
    invoiceTotal: asNum_(r['Invoice Total']),
    amountPaid: asNum_(r['Amount Paid']),
    cardSurcharge: asNum_(r['Card Surcharge']),
    dealerNextDueDate: asYmd_(r['Dealer Next Due Date']),
    dealerNextDueMiles: asNum_(r['Dealer Next Due Miles']),
    source: asStr_(r['Source']),
    needsReview: asYesNo_(r['Needs Review']),
    notes: asStr_(r['Notes']),
    addedBy: asStr_(r['Added By']),
    addedAt: asIso_(r['Added At']),
  };
}

function normVisitServices_(tab) { return normRows_(tab, normVisitService_); }

function normVisitService_(r) {
  const vehicle = asStr_(r['Vehicle']);
  if (!vehicle) return null;
  return {
    _row: r._row,
    vehicle: vehicle,
    visitId: asStr_(r['Visit ID']),
    date: asYmd_(r['Date']),
    mileage: asNum_(r['Mileage']),
    serviceType: asStr_(r['Service Type']),
    description: asStr_(pick_(r, ['Description (as printed)', 'Description'])),
    lineCost: asNum_(r['Line Cost']),
    notes: asStr_(r['Notes']),
  };
}

function normDocuments_(tab) { return normRows_(tab, normDocument_); }

function normDocument_(r) {
  const vehicle = asStr_(r['Vehicle']);
  if (!vehicle) return null;
  return {
    _row: r._row,
    visitId: asStr_(r['Visit ID']),
    vehicle: vehicle,
    documentType: asStr_(r['Document Type']),
    fileName: asStr_(r['File Name']),
    fileId: asStr_(r['Drive File ID']),
    pages: asInt_(r['Pages']),
    complete: asYesNo_(r['Complete']),
    notes: asStr_(r['Notes']),
  };
}

function normRecommendations_(tab) { return normRows_(tab, normRecommendation_); }

function normRecommendation_(r) {
  const recId = asStr_(r['Rec ID']);
  const vehicle = asStr_(r['Vehicle']);
  if (!recId || !vehicle) return null;
  return {
    _row: r._row,
    recId: recId,
    vehicle: vehicle,
    visitId: asStr_(r['Visit ID']),
    date: asYmd_(r['Date']),
    mileage: asNum_(r['Mileage']),
    item: asStr_(r['Item']),
    estimate: asNum_(r['Estimate']),
    status: asStr_(r['Status']),
    resolvedByVisit: asStr_(r['Resolved By Visit']),
    notes: asStr_(r['Notes']),
  };
}

function normReadings_(tab) { return normRows_(tab, normReading_); }

function normReading_(r) {
  const vehicle = asStr_(r['Vehicle']);
  if (!vehicle) return null;
  return {
    _row: r._row,
    vehicle: vehicle,
    visitId: asStr_(r['Visit ID']),
    date: asYmd_(r['Date']),
    mileage: asNum_(r['Mileage']),
    item: asStr_(r['Item']),
    value: asNum_(r['Value']),
    unit: asStr_(r['Unit']),
    rating: asStr_(r['Rating']),
  };
}

function normSchedule_(tab) { return normRows_(tab, normScheduleRow_); }

/** Schedule values are the Sheet formulas' results, passed through as they are. */
function normScheduleRow_(r) {
  const vehicle = asStr_(r['Vehicle']);
  if (!vehicle) return null;
  return {
    _row: r._row,
    vehicle: vehicle,
    serviceType: asStr_(r['Service Type']),
    intervalMonths: asNum_(r['Interval Months']),
    intervalMiles: asNum_(r['Interval Miles']),
    intervalSource: asStr_(r['Interval Source']),
    lastDoneDate: asYmd_(r['Last Done Date']),
    lastDoneMiles: asNum_(r['Last Done Miles']),
    nextDueDate: asYmd_(r['Next Due Date']),
    nextDueMiles: asNum_(r['Next Due Miles']),
    estDateForMiles: asYmd_(r['Est. Date for Miles']),
    dueBy: asYmd_(r['Due By']),
    status: asStr_(r['Status']),
    todoistTaskId: asStr_(r['Todoist Task ID']),
  };
}

function normWarranties_(tab) { return normRows_(tab, normWarranty_); }

/** Covers stays as written (coversText); Logic.js parses it (parseCovers_). */
function normWarranty_(r) {
  const vehicle = asStr_(r['Vehicle']);
  const name = asStr_(r['Warranty']);
  if (!vehicle || !name) return null;
  return {
    _row: r._row,
    vehicle: vehicle,
    name: name,
    startDate: asYmd_(r['Start Date']),
    endDate: asYmd_(r['End Date']),
    startMiles: asNum_(r['Start Miles']),
    endMiles: asNum_(r['End Miles']),
    notes: asStr_(r['Notes']),
    type: asStr_(r['Type']),
    coversText: asStr_(r['Covers']),
  };
}

function normServiceTypes_(tab) { return normRows_(tab, normServiceType_); }

function normServiceType_(r) {
  const name = asStr_(r['Service Type']);
  if (!name) return null;
  return {
    _row: r._row,
    name: name,
    synonyms: splitList_(pick_(r, ['Receipt Synonyms (for matching)', 'Receipt Synonyms'])),
  };
}

// ---------------------------------------------------------------- app-owned tabs

function normOdometer_(tab) { return normRows_(tab, normOdometerRow_); }

function normOdometerRow_(r) {
  const vehicle = asStr_(r['Vehicle']);
  if (!vehicle) return null;
  return {
    _row: r._row,
    readingId: asStr_(r['Reading ID']),
    vehicle: vehicle,
    date: asYmd_(r['Date']),
    mileage: asNum_(r['Mileage']),
    enteredBy: asStr_(r['Entered By']),
    enteredAt: asIso_(r['Entered At']),
    note: asStr_(r['Note']),
  };
}

function normAppScans_(tab) { return normRows_(tab, normAppScan_); }

/** Uploaded By holds the uploader's email (see DECISIONS.md), lower-cased here. */
function normAppScan_(r) {
  const scanId = asStr_(r['Scan ID']);
  if (!scanId) return null;
  return {
    _row: r._row,
    scanId: scanId,
    kind: asStr_(r['Kind']),
    vehicleHint: asStr_(r['Vehicle Hint']),
    fileId: asStr_(r['Drive File ID']),
    fileName: asStr_(r['File Name']),
    pages: asInt_(r['Pages']),
    uploadedBy: asStr_(r['Uploaded By']) === null ? null : lower_(r['Uploaded By']),
    uploadedAt: asIso_(r['Uploaded At']),
    status: asStr_(r['Status']),
    statusDetail: asStr_(r['Status Detail']),
    visitId: asStr_(r['Visit ID']),
    lastChecked: asIso_(r['Last Checked']),
  };
}

function normRecalls_(tab) { return normRows_(tab, normRecall_); }

function normRecall_(r) {
  const vehicle = asStr_(r['Vehicle']);
  const campaign = asStr_(r['Campaign Number']);
  if (!vehicle || !campaign) return null;
  return {
    _row: r._row,
    vehicle: vehicle,
    campaignNumber: campaign,
    reportDate: asYmd_(r['Report Date']),
    component: asStr_(r['Component']),
    summary: asStr_(r['Summary']),
    consequence: asStr_(r['Consequence']),
    remedy: asStr_(r['Remedy']),
    status: asStr_(r['Status']),
    firstSeen: asYmd_(r['First Seen']),
    notes: asStr_(r['Notes']),
    parkIt: asYesNo_(r['Park It']) === true,
    parkOutside: asYesNo_(r['Park Outside']) === true,
  };
}

function normAppUsers_(tab) { return normRows_(tab, normAppUser_); }

function normAppUser_(r) {
  const email = lower_(r['Email']);
  if (!email) return null;
  return {
    _row: r._row,
    email: email,
    name: asStr_(r['Name']),
    defaultVehicle: asStr_(r['Default Vehicle']),
    active: lower_(r['Active']) === VALUES.ACTIVE_YES,
    prefs: parsePrefs_(r['Notification Prefs']),
    driverName: asStr_(r['Driver Name']),
  };
}

/**
 * Notification Prefs JSON → {event: boolean}. Bad JSON gives {} (everything
 * on); unknown keys and non-boolean values are dropped.
 */
function parsePrefs_(v) {
  const o = parseJsonObject_(v);
  const out = {};
  if (!o) return out;
  NOTIFY_EVENTS.forEach(k => {
    if (typeof o[k] === 'boolean') out[k] = o[k];
  });
  return out;
}

function normPushSubscriptions_(tab) { return normRows_(tab, normPushSubscription_); }

/** Keys is stored as JSON {"p256dh": "...", "auth": "..."}; unreadable → null. */
function normPushSubscription_(r) {
  const endpoint = asStr_(r['Endpoint']);
  if (!endpoint) return null;
  return {
    _row: r._row,
    email: lower_(r['Email']),
    endpoint: endpoint,
    keys: parseJsonObject_(r['Keys']),
    deviceLabel: asStr_(r['Device Label']),
    createdAt: asIso_(r['Created At']),
    lastSuccess: asIso_(r['Last Success']),
    active: lower_(r['Active']) === VALUES.ACTIVE_YES,
  };
}

function normNotificationLog_(tab) { return normRows_(tab, normNotificationLogRow_); }

function normNotificationLogRow_(r) {
  const key = asStr_(r['Key']);
  if (!key) return null;
  return {
    _row: r._row,
    key: key,
    email: lower_(r['Email']),
    title: asStr_(r['Title']),
    sentAt: asIso_(r['Sent At']),
    result: asStr_(r['Result']),
  };
}
