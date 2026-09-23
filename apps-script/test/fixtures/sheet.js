'use strict';
/**
 * A SYNTHETIC journal Sheet for tests and for the mock bootstrap
 * (npm run fixture). Every person, email, VIN, plate, Drive/Sheet ID, visit
 * ID, repair order, shop name and amount below is made up. Only the tab
 * names, headers and data patterns mirror the real journal.
 *
 * Shape: `tabs[<tab name>]` is what Range.getValues() returns for the whole
 * tab: row 0 = headers, then data rows. Dates are Date objects at local noon,
 * exactly like the ingestion script writes them (run with TZ=America/Chicago),
 * numbers are numbers, and HYPERLINK cells hold their display text.
 *
 * The Vehicles and Warranties tabs already carry the columns setupSchema adds,
 * the formula columns hold the values the Sheet would compute on TODAY, and
 * the app-owned tabs exist. preSetupTabs() returns the journal as it looks
 * before setupSchemaApply(), with LIVE_FORMULAS for its formula cells.
 */

const TODAY = '2026-09-22';

/** "2026-09-22" → Date at local noon. */
function d(ymd) {
  const [y, m, day] = ymd.split('-').map(Number);
  return new Date(y, m - 1, day, 12, 0, 0);
}

/** ("2026-09-21", "18:05") → local Date. */
function dt(ymd, hhmm) {
  const [y, m, day] = ymd.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  return new Date(y, m - 1, day, hh, mm, 0);
}

// ---------------------------------------------------------------- headers (live journal + setupSchema)

const LIVE_HEADERS = {
  'Vehicles': ['Vehicle', 'Year', 'Make', 'Model', 'VIN', 'VIN Last 6', 'Plate', 'Primary Driver', 'Active',
    'Drive Folder ID', 'Original In-Service Date', 'Purchase Date', 'Purchase Mileage', 'Last Visit Date',
    'Last Known Mileage', 'Avg Miles/Day', 'Est. Current Mileage', 'Dealer Next Due Date', 'Dealer Next Due Miles',
    'Notes', 'Purchase Price'],
  'Visits': ['Visit ID', 'Vehicle', 'Date', 'Mileage', 'Location', 'RO #', 'Summary', 'Invoice Total', 'Amount Paid',
    'Card Surcharge', 'Dealer Next Due Date', 'Dealer Next Due Miles', 'Source', 'Receipt', 'Needs Review', 'Notes',
    'Added By', 'Added At'],
  'Visit Services': ['Vehicle', 'Visit ID', 'Date', 'Mileage', 'Service Type', 'Description (as printed)',
    'Line Cost', 'Notes'],
  'Documents': ['Visit ID', 'Vehicle', 'Document Type', 'File Name', 'Drive File ID', 'Link', 'Pages', 'Complete',
    'Notes'],
  'Recommendations': ['Rec ID', 'Vehicle', 'Visit ID', 'Date', 'Mileage', 'Item', 'Estimate', 'Status',
    'Resolved By Visit', 'Notes'],
  'Inspection Readings': ['Vehicle', 'Visit ID', 'Date', 'Mileage', 'Item', 'Value', 'Unit', 'Rating'],
  'Schedule': ['Vehicle', 'Service Type', 'Interval Months', 'Interval Miles', 'Interval Source', 'Last Done Date',
    'Last Done Miles', 'Next Due Date', 'Next Due Miles', 'Est. Date for Miles', 'Due By', 'Status',
    'Todoist Task ID'],
  'Warranties': ['Vehicle', 'Warranty', 'Start Date', 'End Date', 'Start Miles', 'End Miles', 'Notes'],
  'Service Types': ['Service Type', 'Receipt Synonyms (for matching)'],
  'Log': ['Timestamp', 'Source', 'Level', 'Message'],
};

// Copies of NEW_VEHICLE_COLUMNS, NEW_WARRANTY_COLUMNS and APP_TAB_HEADERS in
// Config.js (model.test.js checks they stay in sync).
const NEW_VEHICLE_COLUMNS = ['Photo File ID', 'Oil Spec', 'Oil Capacity', 'Oil Filter', 'Engine Air Filter',
  'Cabin Air Filter', 'Tire Size', 'Tire Pressure', 'Wiper Front Driver', 'Wiper Front Passenger', 'Wiper Rear',
  'Battery Group', 'Registration Expires', 'Registration File ID', 'NHTSA Make', 'NHTSA Model', 'OEM App Name',
  'OEM App Link', 'OEM App Store Link', 'Latest Odometer', 'Latest Odometer Date'];
const NEW_WARRANTY_COLUMNS = ['Type', 'Covers'];
const APP_TAB_HEADERS = {
  'App Users': ['Email', 'Name', 'Default Vehicle', 'Active', 'Notification Prefs', 'Driver Name'],
  'Odometer Readings': ['Reading ID', 'Vehicle', 'Date', 'Mileage', 'Entered By', 'Entered At', 'Note'],
  'App Scans': ['Scan ID', 'Kind', 'Vehicle Hint', 'Drive File ID', 'File Name', 'Pages', 'Uploaded By',
    'Uploaded At', 'Status', 'Status Detail', 'Visit ID', 'Last Checked'],
  'Recalls': ['Vehicle', 'Campaign Number', 'Report Date', 'Component', 'Summary', 'Consequence', 'Remedy',
    'Status', 'First Seen', 'Notes', 'Park It', 'Park Outside'],
  'Push Subscriptions': ['Email', 'Endpoint', 'Keys', 'Device Label', 'Created At', 'Last Success', 'Active'],
  'Notification Log': ['Key', 'Email', 'Title', 'Sent At', 'Result'],
};

const HEADERS = Object.assign({}, LIVE_HEADERS, {
  'Vehicles': LIVE_HEADERS['Vehicles'].concat(NEW_VEHICLE_COLUMNS),
  'Warranties': LIVE_HEADERS['Warranties'].concat(NEW_WARRANTY_COLUMNS),
}, APP_TAB_HEADERS);

/** Header-keyed objects → getValues()-style rows. Unknown keys throw (catches typos). */
function table(name, objects) {
  const headers = HEADERS[name];
  return [headers.slice()].concat(objects.map(o => {
    Object.keys(o).forEach(k => {
      if (headers.indexOf(k) === -1) throw new Error('fixture: unknown column "' + k + '" on ' + name);
    });
    return headers.map(h => (h in o && o[h] !== null && o[h] !== undefined ? o[h] : ''));
  }));
}

// ---------------------------------------------------------------- people and vehicles

const USERS = {
  owner: 'robert@example.com',          // Robert, Driver Name "Bob": BMW X7 and Jeep Wrangler
  fourRunnerDriver: 'leo@example.com',  // Leo (no Driver Name: matches on Name)
  highlanderDriver: 'maya@example.com', // stored as "Maya@Example.com" to test case-insensitivity
  tellurideDriver: 'nina@example.com',
};

const HL = '2014 Toyota Highlander';
const JP = '2016 Jeep Wrangler';
const X7 = '2023 BMW X7';
const R4 = '2023 Toyota 4Runner';
const TL = '2025 Kia Telluride SX Prestige';

// Formula columns hold what the Sheet computes on TODAY (Avg Miles/Day and
// Est. Current Mileage from Latest Odometer, as after the section 5.3 change).
const vehicles = [
  {
    'Vehicle': HL, 'Year': 2014, 'Make': 'Toyota', 'Model': 'Highlander', 'VIN': 'TESTVIN0000000001',
    'VIN Last 6': '000001', 'Plate': 'SAMPLE1', 'Primary Driver': 'Maya', 'Active': 'Yes',
    'Drive Folder ID': 'fake-folder-hl', 'Original In-Service Date': d('2014-05-17'),
    'Purchase Date': d('2014-05-17'), 'Purchase Mileage': 7, 'Last Visit Date': d('2025-12-02'),
    'Last Known Mileage': 134120, 'Avg Miles/Day': 31.8, 'Est. Current Mileage': 143469,
    'Dealer Next Due Date': d('2024-08-20'), 'Dealer Next Due Miles': 119800,
    'Notes': 'Bought new. Synthetic sample vehicle.', 'Purchase Price': 43500,
    'Photo File ID': 'fake-photo-hl', 'Oil Spec': '0W-20 full synthetic', 'Oil Capacity': '6.4 qt',
    'Oil Filter': 'SAMPLE-OF-100', 'Tire Size': '245/55R19', 'Tire Pressure': '35 psi front / 35 psi rear',
    'Wiper Front Driver': '26 in', 'Wiper Front Passenger': '20 in', 'Wiper Rear': '16 in', 'Battery Group': '24F',
    'Registration Expires': d('2026-09-01'), 'Registration File ID': 'fake-reg-hl',
    'NHTSA Make': 'TOYOTA', 'NHTSA Model': 'HIGHLANDER',
    'Latest Odometer': 134120, 'Latest Odometer Date': d('2025-12-02'),
  },
  {
    'Vehicle': JP, 'Year': 2016, 'Make': 'Jeep', 'Model': 'Wrangler', 'VIN': 'TESTVIN0000000002',
    'VIN Last 6': '000002', 'Primary Driver': 'Bob', 'Active': 'Yes', 'Drive Folder ID': 'fake-folder-jp',
    'Purchase Date': d('2016-08-12'), 'Purchase Mileage': 3150, 'Last Visit Date': d('2025-12-20'),
    'Last Known Mileage': 77900, 'Avg Miles/Day': 21.7, 'Est. Current Mileage': 83199,
    'Dealer Next Due Date': d('2025-04-10'), 'Dealer Next Due Miles': 72420,
    'Notes': 'Bought used. Synthetic sample vehicle.', 'Purchase Price': 36900,
    'Photo File ID': 'fake-photo-jp', 'Oil Spec': '5W-20',
    'Registration Expires': d('2026-10-15'), 'Registration File ID': 'fake-reg-jp',
    'NHTSA Make': 'JEEP', 'NHTSA Model': 'WRANGLER',
    'Latest Odometer': 82700, 'Latest Odometer Date': d('2026-08-30'),
  },
  {
    'Vehicle': X7, 'Year': 2023, 'Make': 'BMW', 'Model': 'X7', 'VIN': 'TESTVIN0000000003', 'VIN Last 6': '000003',
    'Primary Driver': 'Bob', 'Active': 'Yes', 'Drive Folder ID': 'fake-folder-x7',
    'Original In-Service Date': d('2023-02-20'), 'Purchase Date': d('2024-11-30'), 'Purchase Mileage': 20480,
    'Last Visit Date': d('2026-02-12'), 'Last Known Mileage': 39020, 'Avg Miles/Day': 42.2,
    'Est. Current Mileage': 48388,
    'Photo File ID': 'fake-photo-x7', 'Oil Spec': '0W-20', 'Tire Size': '275/45R21 front, 315/40R21 rear',
    'NHTSA Make': 'BMW', 'NHTSA Model': 'X7',
    'OEM App Name': 'My BMW', 'OEM App Link': 'mybmw://', 'OEM App Store Link': 'https://apps.apple.com/app/id0000000003',
    'Latest Odometer': 39020, 'Latest Odometer Date': d('2026-02-12'),
  },
  {
    'Vehicle': R4, 'Year': 2023, 'Make': 'Toyota', 'Model': '4Runner', 'VIN': 'TESTVIN0000000004',
    'VIN Last 6': '000004', 'Plate': 'SAMPLE4', 'Primary Driver': 'Leo', 'Active': 'Yes',
    'Drive Folder ID': 'fake-folder-4r', 'Original In-Service Date': d('2023-01-25'),
    'Purchase Date': d('2026-04-10'), 'Purchase Mileage': 28640, 'Last Visit Date': d('2026-09-03'),
    'Last Known Mileage': 36690, 'Avg Miles/Day': 54.9, 'Est. Current Mileage': 37704,
    'Dealer Next Due Date': d('2026-12-25'), 'Dealer Next Due Miles': 40000,
    'Notes': 'Bought used; history before purchase from CarFax. Synthetic sample vehicle.',
    'Photo File ID': 'fake-photo-4r', 'Oil Spec': '0W-20 full synthetic', 'Oil Capacity': '6.6 qt',
    'Oil Filter': 'SAMPLE-OF-400', 'Engine Air Filter': 'SAMPLE-AF-400', 'Cabin Air Filter': 'SAMPLE-CF-400',
    'Tire Size': '265/70R17', 'Tire Pressure': 32, 'Wiper Front Driver': '22 in',
    'Wiper Front Passenger': '20 in', 'Wiper Rear': '14 in', 'Battery Group': '24F',
    'Registration Expires': d('2027-03-31'), 'Registration File ID': 'fake-reg-4r',
    'NHTSA Make': 'TOYOTA', 'NHTSA Model': '4RUNNER',
    'OEM App Name': 'Toyota', 'OEM App Link': 'toyota://',
    'Latest Odometer': 37320, 'Latest Odometer Date': d('2026-09-15'),
  },
  {
    'Vehicle': TL, 'Year': 2025, 'Make': 'Kia', 'Model': 'Telluride SX Prestige', 'VIN': 'TESTVIN0000000005',
    'VIN Last 6': '000005', 'Primary Driver': 'Nina', 'Active': 'Yes', 'Drive Folder ID': 'fake-folder-tl',
    'Original In-Service Date': d('2025-11-14'), 'Purchase Date': d('2025-11-14'), 'Purchase Mileage': 12,
    'Last Visit Date': d('2026-08-05'), 'Last Known Mileage': 10180, 'Avg Miles/Day': 38.5,
    'Est. Current Mileage': 12028, 'Notes': 'Bought new. Synthetic sample vehicle.', 'Purchase Price': 52800,
    'Photo File ID': 'fake-photo-tl', 'Oil Spec': '5W-30 full synthetic',
    'Registration Expires': d('2026-11-30'), 'Registration File ID': 'fake-reg-tl',
    'NHTSA Make': 'KIA', 'NHTSA Model': 'TELLURIDE',
    'OEM App Name': 'Kia', 'OEM App Store Link': 'https://apps.apple.com/app/id0000000005',
    'Latest Odometer': 10180, 'Latest Odometer Date': d('2026-08-05'),
  },
];

// ---------------------------------------------------------------- visits

/** One Visits row. `x` adds any other columns (Amount Paid, Dealer Next Due ..., Notes). */
function visit(id, vehicle, date, mileage, location, ro, summary, total, source, x) {
  return Object.assign({
    'Visit ID': id, 'Vehicle': vehicle, 'Date': d(date), 'Mileage': mileage, 'Location': location, 'RO #': ro,
    'Summary': summary, 'Invoice Total': total, 'Source': source,
    'Receipt': source === 'Receipt' ? 'Receipt' : '', 'Needs Review': 'No',
    'Added By': source === 'Receipt' ? 'Claude' : 'Robert', 'Added At': dt('2026-09-21', '15:30'),
  }, x || {});
}

// Rows are deliberately not sorted, like the live tab.
const visits = [
  // 2023 Toyota 4Runner: CarFax history before purchase, then receipts.
  visit('4r-20230125-carfax', R4, '2023-01-25', 15, 'Cedar Valley Toyota', null, 'Sold new to first owner', null, 'CarFax',
    { 'Notes': 'From CarFax; no receipt on file.' }),
  visit('4r-20230905-carfax', R4, '2023-09-05', 5300, 'Cedar Valley Toyota', null, 'Tire rotation', null, 'CarFax'),
  visit('4r-20240420-carfax', R4, '2024-04-20', 10050, 'Cedar Valley Toyota', null, '10k mile service', null, 'CarFax'),
  visit('4r-20250722-carfax', R4, '2025-07-22', 22180, 'Cedar Valley Toyota', null, '20k mile service; oil change', null, 'CarFax'),
  visit('4r-20260220-carfax', R4, '2026-02-20', 28100, 'Cedar Valley Toyota', null, '25k mile service', null, 'CarFax'),
  visit('4r-20260328-carfax', R4, '2026-03-28', 28630, 'Lakeview Toyota', null,
    'Pre-sale reconditioning: air and cabin filters, oil and filter, battery service', null, 'CarFax'),
  visit('4r-20260410-purchase', R4, '2026-04-10', 28640, 'Lakeview Toyota', null,
    'Purchased used — odometer baseline for our ownership', null, 'Purchase',
    { 'Notes': 'Cost left blank so the vehicle price does not distort maintenance totals.' }),
  visit('4r-20260903-L1102', R4, '2026-09-03', 36690, 'Lakeview Toyota', 'L1102',
    'Windshield replaced (rock chip); windshield camera recalibrated', 1642.10, 'Receipt',
    { 'Amount Paid': 1683.15, 'Card Surcharge': 41.05, 'Dealer Next Due Date': d('2026-12-25'),
      'Dealer Next Due Miles': 40000, 'Notes': 'Invoice pages 3-4 of 4 not in scan.' }),
  visit('4r-20260824-L1101', R4, '2026-08-24', 36410, 'Lakeview Toyota', 'L1101',
    'Oil change (0W-20), tire rotation, multi-point inspection', 158.40, 'Receipt',
    { 'Amount Paid': 163.15, 'Card Surcharge': 4.75, 'Dealer Next Due Date': d('2026-12-06'),
      'Dealer Next Due Miles': 40000, 'Notes': 'Declined: windshield ($1,480.00), front wipers ($54.00).' }),
  visit('4r-20260901-owner', R4, '2026-09-01', 36500, 'Owner-performed (Leo)', null,
    'Front wiper blades replaced by owner', 32.50, 'Owner-reported'),

  // 2025 Kia Telluride SX Prestige: bought new, few visits.
  visit('tl-20260805-K2203', TL, '2026-08-05', 10180, 'Hometown Kia', 'K2203',
    'Tire repair (patch/plug), multi-point inspection', 27.40, 'Receipt', { 'Amount Paid': 27.40 }),
  visit('tl-20260710-K2202', TL, '2026-07-10', 9050, 'Hometown Kia', 'K2202',
    'Oil change, tire rotation with brake inspection', 151.20, 'Receipt', { 'Amount Paid': 151.20 }),
  visit('tl-20260330-K2201', TL, '2026-03-30', 5020, 'Hometown Kia', 'K2201',
    'Oil change, service campaign (software update), video inspection', 104.80, 'Receipt'),
  visit('tl-20251114-purchase', TL, '2025-11-14', 12, 'Sunflower Kia', null,
    'Purchased new — odometer baseline', null, 'Purchase'),

  // 2023 BMW X7: CarFax visits BEFORE the purchase date.
  visit('x7-20260212-B9002', X7, '2026-02-12', 39020, 'Metro BMW', 'B9002',
    'Coolant service, tire rotation, wipers, cabin and engine filters, brake fluid, oil change', 412.18, 'Receipt',
    { 'Amount Paid': 412.18, 'Notes': 'Most lines no-charge under the prepaid plan.' }),
  visit('x7-20250710-B9001', X7, '2025-07-10', 30650, 'Metro BMW', 'B9001',
    'Standard scope check, oil change, inspection — all no charge', 0, 'Receipt'),
  visit('x7-20230502-carfax', X7, '2023-05-02', null, 'Plains BMW', null,
    'Vehicle serviced — no detail reported', null, 'CarFax', { 'Notes': 'No mileage reported.' }),
  visit('x7-20230220-carfax', X7, '2023-02-20', 12, 'Plains BMW', null, 'Sold new; delivery inspection', null, 'CarFax'),
  visit('x7-20230808-carfax', X7, '2023-08-08', 5540, 'Plains BMW', null,
    'Brake fluid flushed; software update', null, 'CarFax'),
  visit('x7-20231219-carfax', X7, '2023-12-19', 11210, 'Plains BMW', null,
    'Oil and filter change; maintenance inspection', null, 'CarFax'),
  visit('x7-20241022-carfax', X7, '2024-10-22', 20470, 'Plains BMW', null,
    'Dealer reconditioning: four new tires, oil and filter change', null, 'CarFax'),
  visit('x7-20241130-purchase', X7, '2024-11-30', 20480, 'Prairie Auto Campus', null,
    'Purchased used — odometer baseline for our ownership', null, 'Purchase'),

  // 2016 Jeep Wrangler: pre-2020 dealer visits, owner-reported ones, a visit
  // before purchase at the selling dealer.
  visit('jp-20160812-purchase', JP, '2016-08-12', 3150, 'County Line Ford', null,
    'Purchased used with 3,150 miles — odometer baseline', null, 'Purchase'),
  visit('jp-20160628-F5001', JP, '2016-06-28', 3140, 'County Line Ford', 'F5001',
    "Selling dealer's pre-delivery inspection: oil and filter change", 0, 'Receipt', { 'Amount Paid': 0 }),
  visit('jp-20170210-N6001', JP, '2017-02-10', 11020, 'Northside Chrysler Jeep', 'N6001',
    'Oil change and tire rotation under warranty', 0, 'Receipt'),
  visit('jp-20170930-N6002', JP, '2017-09-30', 19480, 'Northside Chrysler Jeep', 'N6002',
    'Oil change and tire rotation under warranty', 0, 'Receipt'),
  visit('jp-20180720-N6003', JP, '2018-07-20', 27700, 'Northside Chrysler Jeep', 'N6003',
    'Oil change and rotation, prepaid plan purchased, engine air filter', 168.20, 'Receipt'),
  visit('jp-20190301-N6004', JP, '2019-03-01', 32550, 'Northside Chrysler Jeep', 'N6004',
    'Five-tire rotation; airbag recall completed', 26.49, 'Receipt'),
  visit('jp-20201014-N6005', JP, '2020-10-14', 42600, 'Northside Chrysler Jeep', 'N6005',
    'Oil change and rotation (plan), battery, engine air filter, tire repair', 395.60, 'Receipt'),
  visit('jp-20241127-P8001', JP, '2024-11-27', 68300, 'Prairie Jeep RAM', 'P8001',
    'Thermostat replaced (check engine light); multi-point inspection', 642.75, 'Receipt'),
  visit('jp-20241105-Q4002', JP, '2024-11-05', 67420, 'Quick Lube Express', 'Q4002',
    'Oil change (5W-20 blend), tire rotation', 142.30, 'Receipt',
    { 'Amount Paid': 142.30, 'Dealer Next Due Date': d('2025-04-10'), 'Dealer Next Due Miles': 72420 }),
  visit('jp-20230801-B7001', JP, '2023-08-01', 54800, 'Stop Right Brakes', 'B7001',
    'Rear brake pads and rotors, brake inspection', 488.10, 'Receipt', { 'Amount Paid': 488.10 }),
  visit('jp-20220809-owner', JP, '2022-08-09', 49000, 'Main Street Auto Care', null,
    'Four new tires', null, 'Owner-reported', { 'Notes': 'From the owner\'s log; mileage approximate.' }),
  visit('jp-20251220-rot', JP, '2025-12-20', null, 'Main Street Auto Care', null,
    'Tire rotation (mileage not recorded)', null, 'Owner-reported'),
  visit('jp-20251220-oil', JP, '2025-12-20', 77900, null, null,
    'Oil change — shop not recorded', null, 'Owner-reported'),

  // 2014 Toyota Highlander: bought new, long history, a tire replacement,
  // several blank totals, newest visit 2025-12-02 at the Toyota dealer.
  visit('hl-20250913-owner', HL, '2025-09-13', 133005, 'Quick Lube Express', null,
    'Synthetic oil change (from the owner\'s log)', null, 'Owner journal'),
  visit('hl-20140517-purchase', HL, '2014-05-17', 7, 'Riverside Toyota', null,
    'Purchased new — odometer baseline for our ownership', null, 'Purchase'),
  visit('hl-20150310-R1001', HL, '2015-03-10', 9650, 'Riverside Toyota', 'R1001',
    '10,000 mile synthetic oil change (prepaid plan)', 0, 'Receipt'),
  visit('hl-20160108-R1002', HL, '2016-01-08', 20540, 'Riverside Toyota', 'R1002',
    '20,000 mile service with tire rotation (prepaid plan)', 0, 'Receipt'),
  visit('hl-20161026-R1003', HL, '2016-10-26', 32140, 'Riverside Toyota', 'R1003',
    'Tire rotation and brake inspection; page 1 of 2 missing', 76.15, 'Receipt'),
  visit('hl-20170505-T2001', HL, '2017-05-05', 37700, 'Tire Warehouse', 'T2001',
    'Four new tires installed', 812.40, 'Receipt', { 'Amount Paid': 812.40 }),
  visit('hl-20170711-R1004', HL, '2017-07-11', 41250, 'Riverside Toyota', 'R1004',
    'Synthetic oil change, multi-point inspection', 64.10, 'Receipt'),
  visit('hl-20180406-R1005', HL, '2018-04-06', 50900, 'Riverside Toyota', 'R1005',
    'Oil change; brake noise investigated', null, 'Receipt',
    { 'Notes': 'Invoice total deliberately blank: the totals page is lost.' }),
  visit('hl-20180927-R1006', HL, '2018-09-27', 61300, 'Riverside Toyota', 'R1006',
    'Oil change, front brake pads, complimentary tire rotation', 309.80, 'Receipt'),
  visit('hl-20200519-M3001', HL, '2020-05-19', 81400, 'Main Street Auto Care', 'M3001',
    'Oil change; rear brake pads and rotors; fog light declined', 486.25, 'Receipt', { 'Amount Paid': 486.25 }),
  visit('hl-20220113-M3002', HL, '2022-01-13', 91100, 'Main Street Auto Care', 'M3002',
    'Oil and filter change; air filter declined', 71.30, 'Receipt', { 'Amount Paid': 71.30 }),
  visit('hl-20220420-T2002', HL, '2022-04-20', 95300, 'Tire Warehouse', 'T2002',
    'Four new tires installed', 905.16, 'Receipt', { 'Amount Paid': 905.16 }),
  visit('hl-20230328-T2003', HL, '2023-03-28', 101300, 'Tire Warehouse', 'T2003',
    'Tire rotation and balance', null, 'Receipt'),
  visit('hl-20240314-Q4001', HL, '2024-03-14', 114800, 'Quick Lube Express', 'Q4001',
    'Oil change (0W-20 full synthetic)', 96.20, 'Receipt',
    { 'Amount Paid': 96.20, 'Dealer Next Due Date': d('2024-08-20'), 'Dealer Next Due Miles': 119800 }),
  visit('hl-20240924-R1007', HL, '2024-09-24', 123400, 'Riverside Toyota', 'R1007',
    'Basic maintenance; two bulbs; rear wiper insert (pages 1 and 3 missing)', null, 'Receipt'),
  visit('hl-20241027-T2004', HL, '2024-10-27', 124700, 'Tire Warehouse', 'T2004', 'Tire rotation', null, 'Receipt'),
  visit('hl-20250913-T2005', HL, '2025-09-13', 133000, 'Tire Warehouse', 'T2005', 'Tire rotation', 0, 'Receipt'),
  visit('hl-20251202-R1008', HL, '2025-12-02', 134120, 'Riverside Toyota', 'R1008',
    'Rear brake service (pads, shim kit)', 412.50, 'Receipt', { 'Amount Paid': 412.50 }),
];

// ---------------------------------------------------------------- visit services

function svc(vehicle, visitId, date, mileage, type, desc, cost, notes) {
  return {
    'Vehicle': vehicle, 'Visit ID': visitId, 'Date': d(date), 'Mileage': mileage, 'Service Type': type,
    'Description (as printed)': desc, 'Line Cost': cost, 'Notes': notes,
  };
}

const visitServices = [
  svc(R4, '4r-20230905-carfax', '2023-09-05', 5300, 'Tire Rotation', 'Tires rotated', null),
  svc(R4, '4r-20240420-carfax', '2024-04-20', 10050, 'Scheduled Maintenance', '10k mile service', null),
  svc(R4, '4r-20250722-carfax', '2025-07-22', 22180, 'Scheduled Maintenance', '20k mile service', null),
  svc(R4, '4r-20250722-carfax', '2025-07-22', 22180, 'Oil Change', 'Oil change', null),
  svc(R4, '4r-20260220-carfax', '2026-02-20', 28100, 'Scheduled Maintenance', '25k mile service', null),
  svc(R4, '4r-20260328-carfax', '2026-03-28', 28630, 'Multi-Point Inspection', 'Pre-sale inspection', null),
  svc(R4, '4r-20260328-carfax', '2026-03-28', 28630, 'Engine Air Filter', 'Air filter replaced', null),
  svc(R4, '4r-20260328-carfax', '2026-03-28', 28630, 'Battery Service', 'Battery serviced', null),
  svc(R4, '4r-20260328-carfax', '2026-03-28', 28630, 'Cabin Air Filter', 'Cabin air filter replaced', null),
  svc(R4, '4r-20260328-carfax', '2026-03-28', 28630, 'Oil Change', 'Oil and filter changed', null),
  svc(R4, '4r-20260824-L1101', '2026-08-24', 36410, 'Multi-Point Inspection', 'PERFORM MULTI-POINT INSPECTION', 0),
  svc(R4, '4r-20260824-L1101', '2026-08-24', 36410, 'Oil Change', 'ENGINE OIL CHANGE AND TIRE ROTATE (0W-20)', 138.40,
    'Combined line with tire rotation'),
  svc(R4, '4r-20260824-L1101', '2026-08-24', 36410, 'Tire Rotation', 'ENGINE OIL CHANGE AND TIRE ROTATE', null,
    'Cost included in oil change line'),
  svc(R4, '4r-20260903-L1102', '2026-09-03', 36690, 'Windshield Replacement', 'REPLACE WINDSHIELD', 1150.10),
  svc(R4, '4r-20260903-L1102', '2026-09-03', 36690, 'Windshield Calibration', 'RECALIBRATE WINDSHIELD CAMERA', 372.00),
  svc(R4, '4r-20260901-owner', '2026-09-01', 36500, 'Wiper Blades', 'Front wiper blades replaced by owner', 32.50),

  svc(TL, 'tl-20260805-K2203', '2026-08-05', 10180, 'Other', 'REPAIR TIRE W/ PATCH PLUG', 22.95),
  svc(TL, 'tl-20260805-K2203', '2026-08-05', 10180, 'Multi-Point Inspection', 'MULTI-POINT INSPECTION', 0),
  svc(TL, 'tl-20260710-K2202', '2026-07-10', 9050, 'Oil Change', 'CHANGE ENGINE OIL AND FILTER (5W30 FULL SYN)', 92.95),
  svc(TL, 'tl-20260710-K2202', '2026-07-10', 9050, 'Tire Rotation', 'FOUR WHEEL TIRE ROTATION WITH BRAKE INSPECTION', 36.95),
  svc(TL, 'tl-20260710-K2202', '2026-07-10', 9050, 'Multi-Point Inspection', 'VIDEO INSPECTION', 0),
  svc(TL, 'tl-20260330-K2201', '2026-03-30', 5020, 'Multi-Point Inspection', 'VIDEO INSPECTION', 0),
  svc(TL, 'tl-20260330-K2201', '2026-03-30', 5020, 'Oil Change', 'CHANGE ENGINE OIL AND FILTER (5W30 FULL SYN)', 92.95),
  svc(TL, 'tl-20260330-K2201', '2026-03-30', 5020, 'Other', 'SERVICE CAMPAIGN: ENGINE SOFTWARE UPDATE', 0),

  svc(X7, 'x7-20230220-carfax', '2023-02-20', 12, 'Other', 'Delivery inspection (per CarFax)', null),
  svc(X7, 'x7-20230808-carfax', '2023-08-08', 5540, 'Brake Fluid', 'Brake fluid flushed (per CarFax)', null),
  svc(X7, 'x7-20230808-carfax', '2023-08-08', 5540, 'Other', 'Software update (per CarFax)', null),
  svc(X7, 'x7-20231219-carfax', '2023-12-19', 11210, 'Oil Change', 'Oil and filter changed (per CarFax)', null),
  svc(X7, 'x7-20231219-carfax', '2023-12-19', 11210, 'Multi-Point Inspection', 'Maintenance inspection (per CarFax)', null),
  svc(X7, 'x7-20241022-carfax', '2024-10-22', 20470, 'Tires', 'Four tires replaced (per CarFax)', null),
  svc(X7, 'x7-20241022-carfax', '2024-10-22', 20470, 'Oil Change', 'Oil and filter changed (per CarFax)', null),
  svc(X7, 'x7-20250710-B9001', '2025-07-10', 30650, 'Oil Change', 'CBS OIL CHANGE', 0),
  svc(X7, 'x7-20250710-B9001', '2025-07-10', 30650, 'Multi-Point Inspection', 'MULTI-POINT INSPECTION', 0),
  svc(X7, 'x7-20250710-B9001', '2025-07-10', 30650, 'Other', 'STANDARD SCOPE CHECK', 0),
  svc(X7, 'x7-20260212-B9002', '2026-02-12', 39020, 'Coolant', 'COOLING SYSTEM SERVICE', 292.40),
  svc(X7, 'x7-20260212-B9002', '2026-02-12', 39020, 'Tire Rotation', 'TIRE ROTATION', 51.95),
  svc(X7, 'x7-20260212-B9002', '2026-02-12', 39020, 'Wiper Blades', 'REPLACE FRONT WIPERS', 0),
  svc(X7, 'x7-20260212-B9002', '2026-02-12', 39020, 'Wiper Blades', 'REPLACE REAR WIPER', 0),
  svc(X7, 'x7-20260212-B9002', '2026-02-12', 39020, 'Cabin Air Filter', 'REPLACE CABIN AIR FILTERS', 0),
  svc(X7, 'x7-20260212-B9002', '2026-02-12', 39020, 'Engine Air Filter', 'REPLACE ENGINE AIR FILTER', 0),
  svc(X7, 'x7-20260212-B9002', '2026-02-12', 39020, 'Brake Fluid', 'BRAKE FLUID SERVICE', 0),
  svc(X7, 'x7-20260212-B9002', '2026-02-12', 39020, 'Oil Change', 'CBS OIL CHANGE', 0),
  svc(X7, 'x7-20260212-B9002', '2026-02-12', 39020, 'Other', 'KEY FOB BATTERY REPLACED', 0),

  svc(JP, 'jp-20160628-F5001', '2016-06-28', 3140, 'Oil Change', 'Oil and filter change, used vehicle inspection', 0),
  svc(JP, 'jp-20160628-F5001', '2016-06-28', 3140, 'Other', 'PERFORM USED VEHICLE INSPECTION', 0),
  svc(JP, 'jp-20170210-N6001', '2017-02-10', 11020, 'Oil Change', 'LUBE OIL AND FILTER (warranty)', 0),
  svc(JP, 'jp-20170210-N6001', '2017-02-10', 11020, 'Tire Rotation', 'TIRE ROTATION (warranty)', 0),
  svc(JP, 'jp-20170930-N6002', '2017-09-30', 19480, 'Oil Change', 'OIL AND FILTER CHANGE (warranty)', 0),
  svc(JP, 'jp-20170930-N6002', '2017-09-30', 19480, 'Tire Rotation', 'TIRE ROTATION (warranty)', 0),
  svc(JP, 'jp-20180720-N6003', '2018-07-20', 27700, 'Oil Change', 'PREPAID PLAN OIL CHANGE WITH ROTATION', 0),
  svc(JP, 'jp-20180720-N6003', '2018-07-20', 27700, 'Tire Rotation', 'PREPAID PLAN OIL CHANGE WITH ROTATION', 0,
    'Cost included in oil change line'),
  svc(JP, 'jp-20180720-N6003', '2018-07-20', 27700, 'Other', 'PREPAID MAINTENANCE PLAN PURCHASE', 125.00,
    'Plan purchase, not a service'),
  svc(JP, 'jp-20180720-N6003', '2018-07-20', 27700, 'Engine Air Filter', 'AIR FILTER ELEMENT REPLACED', 29.95),
  svc(JP, 'jp-20190301-N6004', '2019-03-01', 32550, 'Tire Rotation', '5 TIRE ROTATION', 22.50),
  svc(JP, 'jp-20190301-N6004', '2019-03-01', 32550, 'Other', 'SAFETY RECALL: PASSENGER AIRBAG INFLATOR (warranty)', 0),
  svc(JP, 'jp-20201014-N6005', '2020-10-14', 42600, 'Oil Change', 'PREPAID PLAN OIL CHANGE WITH ROTATION', 0),
  svc(JP, 'jp-20201014-N6005', '2020-10-14', 42600, 'Tire Rotation', 'PREPAID PLAN OIL CHANGE WITH ROTATION', 0),
  svc(JP, 'jp-20201014-N6005', '2020-10-14', 42600, 'Other', 'PREPAID MAINTENANCE PLAN PURCHASE', 139.50),
  svc(JP, 'jp-20201014-N6005', '2020-10-14', 42600, 'Battery Replacement', 'BATTERY REPLACEMENT', 164.80),
  svc(JP, 'jp-20201014-N6005', '2020-10-14', 42600, 'Engine Air Filter', 'AIR FILTER ELEMENT REPLACED', 33.45),
  svc(JP, 'jp-20201014-N6005', '2020-10-14', 42600, 'Other', 'TIRE REPAIR', 17.50),
  svc(JP, 'jp-20220809-owner', '2022-08-09', 49000, 'Tires', 'New tires (set), per owner\'s log', null),
  svc(JP, 'jp-20230801-B7001', '2023-08-01', 54800, 'Brake Service', 'Rear brake pads and rotors', 452.80),
  svc(JP, 'jp-20230801-B7001', '2023-08-01', 54800, 'Other', 'Brake inspection (no charge)', 0),
  svc(JP, 'jp-20241105-Q4002', '2024-11-05', 67420, 'Oil Change', 'Oil change, 5W-20 synthetic blend', 84.50),
  svc(JP, 'jp-20241105-Q4002', '2024-11-05', 67420, 'Tire Rotation', 'Tire rotate', 27.50),
  svc(JP, 'jp-20241105-Q4002', '2024-11-05', 67420, 'Other', 'Engine oil additive', 16.00),
  svc(JP, 'jp-20241127-P8001', '2024-11-27', 68300, 'Other', 'Thermostat housing replaced (check engine light)', 598.40),
  svc(JP, 'jp-20241127-P8001', '2024-11-27', 68300, 'Multi-Point Inspection', 'Express lane inspection', 0),
  // The rotation's mileage wasn't recorded, so the Sheet's Last Done Miles for
  // Tire Rotation (a separate MAXIFS) comes from the 2024-11-05 row.
  svc(JP, 'jp-20251220-rot', '2025-12-20', null, 'Tire Rotation', 'Tire rotation, per owner\'s log', null),
  svc(JP, 'jp-20251220-oil', '2025-12-20', 77900, 'Oil Change', 'Oil change, per owner\'s log', null),

  svc(HL, 'hl-20150310-R1001', '2015-03-10', 9650, 'Oil Change', '10,000 MILE SYNTHETIC OIL CHANGE', 0),
  svc(HL, 'hl-20150310-R1001', '2015-03-10', 9650, 'Multi-Point Inspection', 'MULTI-POINT INSPECTION', 0),
  svc(HL, 'hl-20160108-R1002', '2016-01-08', 20540, 'Oil Change', '20,000 MILE SYNTHETIC OIL CHANGE', 0),
  svc(HL, 'hl-20160108-R1002', '2016-01-08', 20540, 'Tire Rotation', 'ROTATION (part of the 20k service)', 0),
  svc(HL, 'hl-20160108-R1002', '2016-01-08', 20540, 'Multi-Point Inspection', 'MULTI-POINT INSPECTION', 0),
  svc(HL, 'hl-20161026-R1003', '2016-10-26', 32140, 'Tire Rotation', '4 WHEEL TIRE ROTATION AND BRAKE INSPECTION', 22.45),
  svc(HL, 'hl-20161026-R1003', '2016-10-26', 32140, 'Multi-Point Inspection', 'COMPLIMENTARY INSPECTION', 0),
  svc(HL, 'hl-20161026-R1003', '2016-10-26', 32140, 'Detail', 'COMPLIMENTARY WASH', 0),
  svc(HL, 'hl-20170505-T2001', '2017-05-05', 37700, 'Tires', '4 new tires, mount and balance', 760.00),
  svc(HL, 'hl-20170711-R1004', '2017-07-11', 41250, 'Oil Change', '0W20 SYNTHETIC OIL AND FILTER CHANGE', 57.45),
  svc(HL, 'hl-20170711-R1004', '2017-07-11', 41250, 'Multi-Point Inspection', 'MULTI-POINT INSPECTION', 0),
  svc(HL, 'hl-20180406-R1005', '2018-04-06', 50900, 'Oil Change', '0W20 SYNTHETIC OIL AND FILTER CHANGE', null),
  svc(HL, 'hl-20180406-R1005', '2018-04-06', 50900, 'Brake Service', 'BRAKES SQUEAKING: inspected, no concerns', 0,
    'Inspection only'),
  svc(HL, 'hl-20180927-R1006', '2018-09-27', 61300, 'Oil Change', '0W20 SYNTHETIC OIL AND FILTER CHANGE', 61.85),
  svc(HL, 'hl-20180927-R1006', '2018-09-27', 61300, 'Brake Service', 'FRONT BRAKE PADS', 219.95),
  svc(HL, 'hl-20180927-R1006', '2018-09-27', 61300, 'Tire Rotation', 'COMPLIMENTARY TIRE ROTATION', 0),
  svc(HL, 'hl-20200519-M3001', '2020-05-19', 81400, 'Oil Change', 'Full synthetic oil change', 79.65),
  svc(HL, 'hl-20200519-M3001', '2020-05-19', 81400, 'Brake Service', 'Rear brake pads, rotors, caliper kit', 377.40),
  svc(HL, 'hl-20220113-M3002', '2022-01-13', 91100, 'Oil Change', 'Drain oil, replace filter, 0W20', 66.10),
  svc(HL, 'hl-20220420-T2002', '2022-04-20', 95300, 'Tires', '4 new tires, mount and balance', 850.00),
  svc(HL, 'hl-20230328-T2003', '2023-03-28', 101300, 'Tire Rotation', 'Tire rotation; balance', null),
  svc(HL, 'hl-20240314-Q4001', '2024-03-14', 114800, 'Oil Change', 'Oil change, 0W-20 full synthetic', 88.75),
  svc(HL, 'hl-20240924-R1007', '2024-09-24', 123400, 'Other', 'BASIC MAINTENANCE (no charge)', 0),
  svc(HL, 'hl-20240924-R1007', '2024-09-24', 123400, 'Other', 'REAR HATCH BULB', 17.85),
  svc(HL, 'hl-20240924-R1007', '2024-09-24', 123400, 'Other', 'FRONT SIDE MARKER BULB', 17.85),
  svc(HL, 'hl-20240924-R1007', '2024-09-24', 123400, 'Wiper Blades', 'REAR WIPER INSERT', 16.95),
  svc(HL, 'hl-20241027-T2004', '2024-10-27', 124700, 'Tire Rotation', 'Tire rotation', null),
  svc(HL, 'hl-20250913-T2005', '2025-09-13', 133000, 'Tire Rotation', 'Tire rotation (tire warranty)', 0),
  svc(HL, 'hl-20250913-owner', '2025-09-13', 133005, 'Oil Change', 'Synthetic oil change, per owner\'s log', null),
  svc(HL, 'hl-20251202-R1008', '2025-12-02', 134120, 'Brake Service', 'REAR BRAKE PADS, SHIM KIT', 398.20),
];

// ---------------------------------------------------------------- documents

function doc(visitId, vehicle, type, fileName, fileId, pages, complete, notes) {
  return {
    'Visit ID': visitId, 'Vehicle': vehicle, 'Document Type': type, 'File Name': fileName,
    'Drive File ID': fileId, 'Link': 'Open', 'Pages': pages, 'Complete': complete, 'Notes': notes,
  };
}

const documents = [
  doc('4r-20260824-L1101', R4, 'Invoice + Inspection', '2023 Toyota 4Runner - 2026 08 24 - Lakeview Toyota.pdf',
    'fake-doc-4r-0824-inv', 8, 'Yes', 'Invoice 5/5, inspection 3/3'),
  doc('4r-20260824-L1101', R4, 'Payment', '2023 Toyota 4Runner - 2026 08 24 - Lakeview Toyota (Payment).png',
    'fake-doc-4r-0824-pay', 1, 'Yes'),
  doc('4r-20260903-L1102', R4, 'Invoice + Payment', '2023 Toyota 4Runner - 2026 09 03 - Lakeview Toyota.pdf',
    'fake-doc-4r-0903-inv', 3, 'No', 'Pages 3-4 of 4 missing from scan'),
  doc('4r-20260410-purchase', R4, 'Window sticker', '2023 Toyota 4Runner - Window sticker (MSRP).pdf',
    'fake-doc-4r-sticker', 1, 'Yes'),
  doc('tl-20260805-K2203', TL, 'Invoice', '2025 Kia Telluride SX Prestige - 2026 08 05 - Hometown Kia.png',
    'fake-doc-tl-0805-inv', 1, 'Yes'),
  doc('tl-20260710-K2202', TL, 'Invoice', '2025 Kia Telluride SX Prestige - 2026 07 10 - Hometown Kia.png',
    'fake-doc-tl-0710-inv', 1, 'Yes'),
  doc('tl-20260330-K2201', TL, 'Invoice', '2025 Kia Telluride SX Prestige - 2026 03 30 - Hometown Kia.png',
    'fake-doc-tl-0330-inv', 1, 'Yes'),
  doc('tl-20251114-purchase', TL, 'Purchase paperwork',
    '2025 Kia Telluride SX Prestige - 2025 11 14 - Sunflower Kia (Purchase paperwork).pdf',
    'fake-doc-tl-purchase', null, 'Yes'),
  // One visit with both page images and the merged PDF (listed last here; shown first).
  doc('x7-20260212-B9002', X7, 'Invoice', '2023 BMW X7 - 2026 02 12 - Metro BMW (p1 of 4).png', 'fake-doc-x7-0212-p1', 4, 'Yes'),
  doc('x7-20260212-B9002', X7, 'Invoice', '2023 BMW X7 - 2026 02 12 - Metro BMW (p2 of 4).png', 'fake-doc-x7-0212-p2', 4, 'Yes'),
  doc('x7-20260212-B9002', X7, 'Invoice', '2023 BMW X7 - 2026 02 12 - Metro BMW (p3 of 4).png', 'fake-doc-x7-0212-p3', 4, 'Yes'),
  doc('x7-20260212-B9002', X7, 'Invoice', '2023 BMW X7 - 2026 02 12 - Metro BMW (p4 of 4).png', 'fake-doc-x7-0212-p4', 4, 'Yes'),
  doc('x7-20250710-B9001', X7, 'Invoice', '2023 BMW X7 - 2025 07 10 - Metro BMW.png', 'fake-doc-x7-0710-inv', 2, 'No',
    'Page 2 of 2 missing from scan'),
  doc('x7-20241130-purchase', X7, 'CarFax report', '2023 BMW X7 - CarFax report.pdf', 'fake-doc-x7-carfax', 6, 'Yes'),
  doc('x7-20260212-B9002', X7, 'Invoice', '2023 BMW X7 - 2026 02 12 - Metro BMW.pdf', 'fake-doc-x7-0212-merged', 4, 'Yes',
    'Merged PDF of the four page images'),
  doc('jp-20160812-purchase', JP, 'Purchase paperwork', '2016 Jeep Wrangler - 2016 08 12 - Purchase agreement.png',
    'fake-doc-jp-purchase', null, 'Yes'),
  doc('jp-20160812-purchase', JP, 'Window sticker', '2016 Jeep Wrangler - Window sticker (MSRP)',
    'fake-doc-jp-sticker', null, null, 'No file extension recorded'),
  doc('jp-20201014-N6005', JP, 'Invoice', '2016 Jeep Wrangler - 2020 10 14 - Northside Chrysler Jeep (p1 of 3).png',
    'fake-doc-jp-2010-p1', 2, 'Yes'),
  doc('jp-20201014-N6005', JP, 'Invoice', '2016 Jeep Wrangler - 2020 10 14 - Northside Chrysler Jeep (p2 of 3).png',
    'fake-doc-jp-2010-p2', 2, 'Yes'),
  doc('jp-20201014-N6005', JP, 'Inspection', '2016 Jeep Wrangler - 2020 10 14 - Northside Chrysler Jeep (p3 of 3).png',
    'fake-doc-jp-2010-p3', 1, 'Yes'),
  doc('jp-20230801-B7001', JP, 'Invoice', '2016 Jeep Wrangler - 2023 08 01 - Stop Right Brakes.png',
    'fake-doc-jp-2308-inv', 1, 'Yes'),
  doc('jp-20241127-P8001', JP, 'Invoice', '2016 Jeep Wrangler - 2024 11 27 - Prairie Jeep RAM.png',
    'fake-doc-jp-2411-inv', 1, 'Yes'),
  doc('hl-20140517-purchase', HL, 'Window sticker', '2014 Toyota Highlander - Window sticker (MSRP).png',
    'fake-doc-hl-sticker', 1, 'Yes'),
  doc('hl-20161026-R1003', HL, 'Invoice', '2014 Toyota Highlander - 2016 10 26 - Riverside Toyota.png',
    'fake-doc-hl-1610-inv', 2, 'No', 'Page 1 of 2 missing'),
  doc('hl-20170711-R1004', HL, 'Invoice', '2014 Toyota Highlander - 2017 07 11 - Riverside Toyota (p1 of 3).png',
    'fake-doc-hl-1707-p1', 2, 'Yes'),
  doc('hl-20170711-R1004', HL, 'Invoice', '2014 Toyota Highlander - 2017 07 11 - Riverside Toyota (p2 of 3).png',
    'fake-doc-hl-1707-p2', 2, 'Yes'),
  doc('hl-20170711-R1004', HL, 'Inspection', '2014 Toyota Highlander - 2017 07 11 - Riverside Toyota (p3 of 3).png',
    'fake-doc-hl-1707-p3', 1, 'Yes'),
  doc('hl-20180406-R1005', HL, 'Invoice', '2014 Toyota Highlander - 2018 04 06 - Riverside Toyota.png',
    'fake-doc-hl-1804-inv', 2, 'No', 'Totals page lost'),
  doc('hl-20220420-T2002', HL, 'Invoice', '2014 Toyota Highlander - 2022 04 20 - Tire Warehouse.pdf',
    'fake-doc-hl-2204-inv', 1, 'Yes'),
  doc('hl-20251202-R1008', HL, 'Invoice', '2014 Toyota Highlander - 2025 12 02 - Riverside Toyota.png',
    'fake-doc-hl-1202-inv', 1, 'Yes'),
  doc('hl-20251202-R1008', HL, 'Payment', '2014 Toyota Highlander - 2025 12 02 - Riverside Toyota (payment receipt).png',
    'fake-doc-hl-1202-pay', 1, 'Yes'),
];

// ---------------------------------------------------------------- recommendations

function rec(recId, vehicle, visitId, date, mileage, item, estimate, status, resolvedBy, notes) {
  return {
    'Rec ID': recId, 'Vehicle': vehicle, 'Visit ID': visitId, 'Date': d(date), 'Mileage': mileage, 'Item': item,
    'Estimate': estimate, 'Status': status, 'Resolved By Visit': resolvedBy, 'Notes': notes,
  };
}

const recommendations = [
  rec('REC-4R-001', R4, '4r-20260824-L1101', '2026-08-24', 36410, 'Replace windshield + calibrate camera', 1480.00,
    'Done', '4r-20260903-L1102', 'Declined 8/24'),
  rec('REC-4R-002', R4, '4r-20260824-L1101', '2026-08-24', 36410, 'Front wiper blades', 54.00, 'Done',
    '4r-20260901-owner', 'Declined 8/24'),
  rec('REC-4R-003', R4, '4r-20260824-L1101', '2026-08-24', 36410, 'Cabin air filter', null, 'Watch', null, 'Inspection caution'),
  rec('REC-4R-004', R4, '4r-20260824-L1101', '2026-08-24', 36410, 'Engine air filter', null, 'Watch', null, 'Inspection caution'),
  rec('REC-4R-005', R4, '4r-20260824-L1101', '2026-08-24', 36410, 'Tires — tread 6/32" all four', null, 'Watch', null,
    'Inspection caution'),
  rec('REC-4R-006', R4, '4r-20260824-L1101', '2026-08-24', 36410, 'Brake pads — 6 mm front / 5 mm rear', null, 'Watch',
    null, 'Inspection caution'),
  rec('REC-X7-001', X7, 'x7-20250710-B9001', '2025-07-10', 30650, 'Fuel service', null, 'Open', null, 'No estimate printed'),
  rec('REC-X7-002', X7, 'x7-20250710-B9001', '2025-07-10', 30650, 'Coolant service (cooling system)', null, 'Done',
    'x7-20260212-B9002'),
  rec('REC-X7-003', X7, 'x7-20250710-B9001', '2025-07-10', 30650, 'Four wheel alignment', 189.95, 'Open'),
  rec('REC-HL-001', HL, 'hl-20161026-R1003', '2016-10-26', 32140, 'Spare tire carrier binding', null, 'Done',
    'hl-20170711-R1004'),
  rec('REC-HL-002', HL, 'hl-20200519-M3001', '2020-05-19', 81400, 'Fog light assembly', 139.00, 'Open', null,
    'Declined by customer'),
  rec('REC-HL-003', HL, 'hl-20220113-M3002', '2022-01-13', 91100, 'Air filter', null, 'Open', null, 'Declined'),
  rec('REC-HL-004', HL, 'hl-20180927-R1006', '2018-09-27', 61300, 'Rear brakes starting to show wear', null, 'Done',
    'hl-20251202-R1008'),
  rec('REC-JP-001', JP, 'jp-20241127-P8001', '2024-11-27', 68300, 'Battery tested weak — recheck at next visit', null,
    'Watch'),
];

// ---------------------------------------------------------------- inspection readings

function rd(vehicle, visitId, date, mileage, item, value, unit, rating) {
  return {
    'Vehicle': vehicle, 'Visit ID': visitId, 'Date': d(date), 'Mileage': mileage, 'Item': item, 'Value': value,
    'Unit': unit, 'Rating': rating,
  };
}

const T32 = '/32 in';
const readings = [
  rd(R4, '4r-20260824-L1101', '2026-08-24', 36410, 'Tread — Left Front', 6, T32, 'Caution'),
  rd(R4, '4r-20260824-L1101', '2026-08-24', 36410, 'Tread — Right Front', 6, T32, 'Caution'),
  rd(R4, '4r-20260824-L1101', '2026-08-24', 36410, 'Tread — Left Rear', 6, T32, 'Caution'),
  rd(R4, '4r-20260824-L1101', '2026-08-24', 36410, 'Tread — Right Rear', 6, T32, 'Caution'),
  rd(R4, '4r-20260824-L1101', '2026-08-24', 36410, 'Brake Pad — Left Front', 6, 'mm', 'Caution'),
  rd(R4, '4r-20260824-L1101', '2026-08-24', 36410, 'Brake Pad — Right Front', 6, 'mm', 'Caution'),
  rd(R4, '4r-20260824-L1101', '2026-08-24', 36410, 'Brake Pad — Left Rear', 5, 'mm', 'Caution'),
  rd(R4, '4r-20260824-L1101', '2026-08-24', 36410, 'Brake Pad — Right Rear', 5, 'mm', 'Caution'),

  rd(JP, 'jp-20170210-N6001', '2017-02-10', 11020, 'Battery — Cold Cranking Amps (actual; factory spec 600)', 634, 'CCA'),
  rd(JP, 'jp-20180720-N6003', '2018-07-20', 27700, 'Battery — Cold Cranking Amps (actual; factory spec 600)', 604, 'CCA'),
  rd(JP, 'jp-20201014-N6005', '2020-10-14', 42600, 'Tread — Left Front (outside edge)', 5, T32),
  rd(JP, 'jp-20201014-N6005', '2020-10-14', 42600, 'Tread — Left Front (inside edge)', 6, T32),
  rd(JP, 'jp-20201014-N6005', '2020-10-14', 42600, 'Tread — Right Front (outside edge)', 4, T32, 'Replace'),
  rd(JP, 'jp-20201014-N6005', '2020-10-14', 42600, 'Tread — Right Front (inside edge)', 6, T32),
  rd(JP, 'jp-20201014-N6005', '2020-10-14', 42600, 'Tread — Left Rear', 9, T32),
  rd(JP, 'jp-20201014-N6005', '2020-10-14', 42600, 'Tread — Right Rear', 9, T32),
  rd(JP, 'jp-20230801-B7001', '2023-08-01', 54800, 'Tread — Left Front', 11, T32, 'Good'),
  rd(JP, 'jp-20230801-B7001', '2023-08-01', 54800, 'Tread — Right Front (outside edge)', 11, T32, 'Good'),
  rd(JP, 'jp-20230801-B7001', '2023-08-01', 54800, 'Tread — Left Rear', 11, T32, 'Good'),
  rd(JP, 'jp-20230801-B7001', '2023-08-01', 54800, 'Tread — Right Rear', 11, T32, 'Good'),
  rd(JP, 'jp-20230801-B7001', '2023-08-01', 54800, 'Brake Pad — Left Front', 6, 'mm', 'Good'),
  rd(JP, 'jp-20230801-B7001', '2023-08-01', 54800, 'Brake Pad — Right Front', 6, 'mm', 'Good'),
  rd(JP, 'jp-20230801-B7001', '2023-08-01', 54800, 'Brake Pad — Left Rear', 10, 'mm', 'Good'),
  rd(JP, 'jp-20230801-B7001', '2023-08-01', 54800, 'Brake Pad — Right Rear', 10, 'mm', 'Good'),
  rd(JP, 'jp-20241127-P8001', '2024-11-27', 68300, 'Tread — Left Front (outside edge)', 9, T32, 'Caution'),
  rd(JP, 'jp-20241127-P8001', '2024-11-27', 68300, 'Tread — Left Front (inside edge)', 10, T32, 'Good'),
  rd(JP, 'jp-20241127-P8001', '2024-11-27', 68300, 'Tread — Right Front (outside edge)', 10, T32, 'Good'),
  rd(JP, 'jp-20241127-P8001', '2024-11-27', 68300, 'Tread — Right Front (inside edge)', 10, T32, 'Good'),
  rd(JP, 'jp-20241127-P8001', '2024-11-27', 68300, 'Tread — Left Rear', 10, T32, 'Good'),
  rd(JP, 'jp-20241127-P8001', '2024-11-27', 68300, 'Tread — Right Rear', 10, T32, 'Good'),
  rd(JP, 'jp-20241127-P8001', '2024-11-27', 68300, 'Brake Pad — Left Front', 5, 'mm', 'Good'),
  rd(JP, 'jp-20241127-P8001', '2024-11-27', 68300, 'Brake Pad — Right Front', 5, 'mm', 'Good'),
  rd(JP, 'jp-20241127-P8001', '2024-11-27', 68300, 'Brake Pad — Left Rear', 9, 'mm', 'Good'),
  rd(JP, 'jp-20241127-P8001', '2024-11-27', 68300, 'Brake Pad — Right Rear', 9, 'mm', 'Good'),

  rd(TL, 'tl-20260330-K2201', '2026-03-30', 5020, 'Tread — Left Front', 10, T32, 'Good'),
  rd(TL, 'tl-20260330-K2201', '2026-03-30', 5020, 'Tread — Right Front', 10, T32, 'Good'),
  rd(TL, 'tl-20260330-K2201', '2026-03-30', 5020, 'Tread — Left Rear', 10, T32, 'Good'),
  rd(TL, 'tl-20260330-K2201', '2026-03-30', 5020, 'Tread — Right Rear', 10, T32, 'Good'),
  rd(TL, 'tl-20260330-K2201', '2026-03-30', 5020, 'Brake Pad — Left Front', 10, 'mm', 'Good'),
  rd(TL, 'tl-20260330-K2201', '2026-03-30', 5020, 'Brake Pad — Right Front', 10, 'mm', 'Good'),
  rd(TL, 'tl-20260330-K2201', '2026-03-30', 5020, 'Brake Pad — Left Rear', 9, 'mm', 'Good'),
  rd(TL, 'tl-20260330-K2201', '2026-03-30', 5020, 'Brake Pad — Right Rear', 9, 'mm', 'Good'),
  rd(TL, 'tl-20260710-K2202', '2026-07-10', 9050, 'Tread — Left Front', 10, T32, 'Good'),
  rd(TL, 'tl-20260710-K2202', '2026-07-10', 9050, 'Tread — Right Front', 10, T32, 'Good'),
  rd(TL, 'tl-20260710-K2202', '2026-07-10', 9050, 'Tread — Left Rear', 10, T32, 'Good'),
  rd(TL, 'tl-20260710-K2202', '2026-07-10', 9050, 'Tread — Right Rear', 10, T32, 'Good'),
  rd(TL, 'tl-20260710-K2202', '2026-07-10', 9050, 'Brake Pad — Left Front', 10, 'mm', 'Good'),
  rd(TL, 'tl-20260710-K2202', '2026-07-10', 9050, 'Brake Pad — Right Front', 10, 'mm', 'Good'),
  rd(TL, 'tl-20260710-K2202', '2026-07-10', 9050, 'Brake Pad — Left Rear', 9, 'mm', 'Good'),
  rd(TL, 'tl-20260710-K2202', '2026-07-10', 9050, 'Brake Pad — Right Rear', 9, 'mm', 'Good'),

  // Highlander: tread falls, jumps up after new tires in 2017 and 2022.
  rd(HL, 'hl-20161026-R1003', '2016-10-26', 32140, 'Tread — Left Front', 5, T32),
  rd(HL, 'hl-20161026-R1003', '2016-10-26', 32140, 'Tread — Right Front', 5, T32),
  rd(HL, 'hl-20161026-R1003', '2016-10-26', 32140, 'Tread — Left Rear', 6, T32),
  rd(HL, 'hl-20161026-R1003', '2016-10-26', 32140, 'Tread — Right Rear', 6, T32),
  rd(HL, 'hl-20170711-R1004', '2017-07-11', 41250, 'Tread — Left Front', 11, T32),
  rd(HL, 'hl-20170711-R1004', '2017-07-11', 41250, 'Tread — Right Front', 11, T32),
  rd(HL, 'hl-20170711-R1004', '2017-07-11', 41250, 'Tread — Left Rear', 11, T32),
  rd(HL, 'hl-20170711-R1004', '2017-07-11', 41250, 'Tread — Right Rear', 11, T32),
  rd(HL, 'hl-20170711-R1004', '2017-07-11', 41250, 'Tire Pressure — Left Front', 36, 'PSI'),
  rd(HL, 'hl-20170711-R1004', '2017-07-11', 41250, 'Tire Pressure — Right Front', 36, 'PSI'),
  rd(HL, 'hl-20180406-R1005', '2018-04-06', 50900, 'Brake Pad — Left Front', 7, 'mm'),
  rd(HL, 'hl-20180406-R1005', '2018-04-06', 50900, 'Brake Pad — Right Front', 7, 'mm'),
  rd(HL, 'hl-20180406-R1005', '2018-04-06', 50900, 'Brake Pad — Left Rear', 8, 'mm'),
  rd(HL, 'hl-20180406-R1005', '2018-04-06', 50900, 'Brake Pad — Right Rear', 8, 'mm'),
  rd(HL, 'hl-20180406-R1005', '2018-04-06', 50900, 'Tread — Left Front', 8, T32),
  rd(HL, 'hl-20180406-R1005', '2018-04-06', 50900, 'Tread — Right Front', 8, T32),
  rd(HL, 'hl-20180406-R1005', '2018-04-06', 50900, 'Tread — Left Rear', 8, T32),
  rd(HL, 'hl-20180406-R1005', '2018-04-06', 50900, 'Tread — Right Rear', 8, T32),
  rd(HL, 'hl-20180406-R1005', '2018-04-06', 50900, 'Tire Pressure — Left Front', 35, 'PSI'),
  rd(HL, 'hl-20230328-T2003', '2023-03-28', 101300, 'Tread — Left Front', 10, T32),
  rd(HL, 'hl-20230328-T2003', '2023-03-28', 101300, 'Tread — Right Front', 10, T32),
  rd(HL, 'hl-20230328-T2003', '2023-03-28', 101300, 'Tread — Left Rear', 9, T32),
  rd(HL, 'hl-20230328-T2003', '2023-03-28', 101300, 'Tread — Right Rear', 10, T32),
  rd(HL, 'hl-20240924-R1007', '2024-09-24', 123400, 'Brake Pad — Front', 6, 'mm', 'Good'),
  rd(HL, 'hl-20240924-R1007', '2024-09-24', 123400, 'Brake Pad — Rear', 3, 'mm', 'Caution'),
  rd(HL, 'hl-20241027-T2004', '2024-10-27', 124700, 'Tread — Left Front', 7, T32),
  rd(HL, 'hl-20241027-T2004', '2024-10-27', 124700, 'Tread — Right Front', 7, T32),
  rd(HL, 'hl-20241027-T2004', '2024-10-27', 124700, 'Tread — Left Rear', 6, T32),
  rd(HL, 'hl-20241027-T2004', '2024-10-27', 124700, 'Tread — Right Rear', 7, T32),
  rd(HL, 'hl-20250913-T2005', '2025-09-13', 133000, 'Tread — Left Front', 5, T32, 'Caution'),
  rd(HL, 'hl-20250913-T2005', '2025-09-13', 133000, 'Tread — Right Front', 5, T32, 'Caution'),
  rd(HL, 'hl-20250913-T2005', '2025-09-13', 133000, 'Tread — Left Rear', 5, T32, 'Caution'),
  rd(HL, 'hl-20250913-T2005', '2025-09-13', 133000, 'Tread — Right Rear', 5, T32, 'Caution'),
  rd(HL, 'hl-20251202-R1008', '2025-12-02', 134120, 'Brake Pad — Front', 5, 'mm', 'Caution'),
  rd(HL, 'hl-20251202-R1008', '2025-12-02', 134120, 'Brake Pad — Rear', 10, 'mm', 'Good'),
];

// ---------------------------------------------------------------- schedule (formula results on TODAY)

const RULE_12_8000 = 'Household rule: every 12 months or 8,000 miles, whichever comes first';
const ASSUMED = "Assumed — verify in owner's guide";

function sched(vehicle, type, months, miles, source, lastDate, lastMiles, nextDate, nextMiles, estDate, dueBy, status, todoist) {
  return {
    'Vehicle': vehicle, 'Service Type': type, 'Interval Months': months, 'Interval Miles': miles,
    'Interval Source': source, 'Last Done Date': lastDate && d(lastDate), 'Last Done Miles': lastMiles,
    'Next Due Date': nextDate && d(nextDate), 'Next Due Miles': nextMiles,
    'Est. Date for Miles': estDate && d(estDate), 'Due By': dueBy && d(dueBy), 'Status': status,
    'Todoist Task ID': todoist,
  };
}

const schedule = [
  sched(R4, 'Oil Change', 12, 8000, RULE_12_8000, '2026-08-24', 36410, '2027-08-24', 44410, '2027-01-22', '2027-01-22', 'OK', 'fake-task-01'),
  sched(R4, 'Tire Rotation', 12, 8000, RULE_12_8000, '2026-08-24', 36410, '2027-08-24', 44410, '2027-01-22', '2027-01-22', 'OK', 'fake-task-01'),
  sched(R4, 'Cabin Air Filter', 36, 30000, ASSUMED, '2026-03-28', 28630, '2029-03-28', 58630, '2027-10-08', '2027-10-08', 'OK'),
  sched(R4, 'Engine Air Filter', 36, 30000, ASSUMED, '2026-03-28', 28630, '2029-03-28', 58630, '2027-10-08', '2027-10-08', 'OK'),
  sched(R4, 'Wiper Blades', 12, null, ASSUMED, '2026-09-01', 36500, '2027-09-01', null, null, '2027-09-01', 'OK', 'fake-task-02'),
  sched(HL, 'Oil Change', 12, 8000, RULE_12_8000, '2025-09-13', 133005, '2026-09-13', 141005, '2026-07-07', '2026-07-07', 'Overdue', 'fake-task-03'),
  sched(HL, 'Tire Rotation', 12, 8000, RULE_12_8000, '2025-09-13', 133000, '2026-09-13', 141000, '2026-07-06', '2026-07-06', 'Overdue', 'fake-task-03'),
  sched(JP, 'Oil Change', 12, 8000, RULE_12_8000, '2025-12-20', 77900, '2026-12-20', 85900, '2027-01-24', '2026-12-20', 'OK', 'fake-task-04'),
  sched(JP, 'Tire Rotation', 12, 8000, RULE_12_8000, '2025-12-20', 67420, '2026-12-20', 75420, '2025-09-29', '2025-09-29', 'Overdue', 'fake-task-05'),
  sched(JP, 'Transmission Fluid', 60, 60000, ASSUMED, null, null, null, null, null, null, 'No history'),
  sched(X7, 'Oil Change', 12, 8000, RULE_12_8000, '2026-02-12', 39020, '2027-02-12', 47020, '2026-08-21', '2026-08-21', 'Overdue'),
  sched(X7, 'Tire Rotation', 12, 8000, RULE_12_8000, '2026-02-12', 39020, '2027-02-12', 47020, '2026-08-21', '2026-08-21', 'Overdue'),
  sched(TL, 'Oil Change', 12, 8000, RULE_12_8000, '2026-07-10', 9050, '2027-07-10', 17050, '2027-01-30', '2027-01-30', 'OK'),
  sched(TL, 'Tire Rotation', 12, 8000, RULE_12_8000, '2026-07-10', 9050, '2027-07-10', 17050, '2027-01-30', '2027-01-30', 'OK'),
  sched(TL, 'Cabin Air Filter', 12, 15000, ASSUMED, null, null, null, null, null, null, 'No history'),
];

// ---------------------------------------------------------------- warranties and plans

function plan(vehicle, name, start, end, startMiles, endMiles, notes, type, covers) {
  return {
    'Vehicle': vehicle, 'Warranty': name, 'Start Date': start && d(start), 'End Date': end && d(end),
    'Start Miles': startMiles, 'End Miles': endMiles, 'Notes': notes, 'Type': type, 'Covers': covers,
  };
}

const warranties = [
  plan(R4, 'Gold Certified (comprehensive)', '2026-04-10', '2027-04-10', 28640, 40640, '12 mo / 12k mi from purchase',
    'Warranty', 'All'),
  plan(R4, 'Toyota powertrain', '2023-01-25', '2030-01-25', 0, 100000, '7 yr / 100k mi from in-service date', 'Warranty'),
  plan(HL, 'Tire Warehouse road hazard', '2022-04-20', '2026-10-15', 95300, 150000, 'Covers the 2022 tire set',
    'Tire warranty', 'Tires, Tire Rotation'),
  plan(JP, 'Dealer prepaid maintenance', '2018-07-20', '2020-07-20', 27700, null, 'Expired', 'Prepaid plan',
    'Oil Change, Tire Rotation'),
  plan(X7, 'BMW prepaid maintenance', '2023-02-20', '2027-02-20', 0, 36000, 'Mileage limit already reached', 'Prepaid plan',
    'Oil Change, Brake Fluid, Cabin Air Filter, Engine Air Filter, Wiper Blades'),
  plan(X7, 'New vehicle limited warranty', '2023-02-20', '2027-02-20', 0, 50000, '4 yr / 50k mi', 'Warranty'),
  plan(TL, 'Dealer prepaid maintenance', '2025-11-14', '2028-11-14', 12, 30000, '3 yr / 30k mi', 'Prepaid plan',
    'Oil Change, Tire Rotation'),
  plan(TL, 'Kia powertrain', '2025-11-14', '2035-11-14', 12, 100000, '10 yr / 100k mi', 'Warranty'),
  plan(TL, 'Kia basic', '2025-11-14', '2030-11-14', 12, 60000, '5 yr / 60k mi', 'Warranty'),
];

// ---------------------------------------------------------------- service types (generic, like the live list)

const serviceTypes = [
  ['Oil Change', 'LOF, oil and filter, OILROTATE, synthetic oil service, oil & filter'],
  ['Tire Rotation', 'rotate, rotation, OILROTATE, tires rotation'],
  ['Cabin Air Filter', 'cabin filter, pollen filter'],
  ['Engine Air Filter', 'air filter, engine filter'],
  ['Wiper Blades', 'wipers, wiper inserts'],
  ['Windshield Replacement', 'REPLACEWINDSHIELD, glass sub-assy'],
  ['Windshield Calibration', 'CALWINDSHIELDSENSOR, ADAS calibration, camera calibration'],
  ['Battery Service', 'battery test, battery serviced'],
  ['Battery Replacement', 'new battery'],
  ['Brake Service', 'brake pads, rotors, brake job'],
  ['Brake Fluid', 'brake fluid flush'],
  ['Tires', 'tire replacement, new tires'],
  ['Alignment', 'wheel alignment'],
  ['Coolant', 'coolant flush, antifreeze service'],
  ['Transmission Fluid', 'ATF, transmission service'],
  ['Multi-Point Inspection', 'MPI, inspection'],
  ['Scheduled Maintenance', '5k/10k/15k… mile service'],
  ['Fluid Check', 'fluids checked, top off'],
  ['Detail', 'wash, detail'],
  ['Other', 'anything else'],
  ['Unknown', 'no service listed'],
].map(([name, syn]) => ({ 'Service Type': name, 'Receipt Synonyms (for matching)': syn }));

// ---------------------------------------------------------------- app-owned tabs

const appUsers = [
  { 'Email': 'robert@example.com', 'Name': 'Robert', 'Default Vehicle': X7, 'Active': 'Yes',
    'Notification Prefs': '{"odometerNudge":true,"scanFiled":false}', 'Driver Name': 'Bob' },
  { 'Email': 'leo@example.com', 'Name': 'Leo', 'Default Vehicle': R4, 'Active': 'Yes' },
  { 'Email': 'Maya@Example.com', 'Name': 'Maya', 'Default Vehicle': HL, 'Active': 'Yes',
    'Notification Prefs': '{not json', 'Driver Name': 'Maya' },
  { 'Email': 'nina@example.com', 'Name': 'Nina', 'Default Vehicle': TL, 'Active': 'yes',
    'Notification Prefs': '{"newRecall":true,"bogus":1,"scanFiled":"no"}' },
];

const odometerReadings = [
  { 'Reading ID': 'odo-0001', 'Vehicle': R4, 'Date': d('2026-06-12'), 'Mileage': 33120, 'Entered By': 'Leo',
    'Entered At': dt('2026-06-12', '20:14') },
  { 'Reading ID': 'odo-0002', 'Vehicle': JP, 'Date': d('2026-08-30'), 'Mileage': 82700, 'Entered By': 'Robert',
    'Entered At': dt('2026-08-30', '09:45') },
  { 'Reading ID': 'odo-0003', 'Vehicle': R4, 'Date': d('2026-09-15'), 'Mileage': 37320, 'Entered By': 'Leo',
    'Entered At': dt('2026-09-15', '17:02'), 'Note': 'Before a road trip' },
];

function scan(id, kind, hint, fileId, fileName, pages, by, at, status, detail, visitId, checked) {
  return {
    'Scan ID': id, 'Kind': kind, 'Vehicle Hint': hint, 'Drive File ID': fileId, 'File Name': fileName,
    'Pages': pages, 'Uploaded By': by, 'Uploaded At': dt(at[0], at[1]), 'Status': status, 'Status Detail': detail,
    'Visit ID': visitId, 'Last Checked': checked && dt(checked[0], checked[1]),
  };
}

const appScans = [
  scan('scan-0001', 'Receipt', R4, 'fake-scan-0001', 'App scan - 2023 Toyota 4Runner - 2026-09-21 1805 - Leo.pdf', 2,
    'leo@example.com', ['2026-09-21', '18:05'], 'Waiting', null, null, ['2026-09-22', '07:30']),
  scan('scan-0002', 'Receipt', R4, 'fake-doc-4r-0903-inv', 'App scan - 2023 Toyota 4Runner - 2026-09-04 0810 - Leo.pdf', 3,
    'leo@example.com', ['2026-09-04', '08:10'], 'Filed', null, '4r-20260903-L1102', ['2026-09-04', '12:00']),
  scan('scan-0003', 'Upload', HL, 'fake-scan-0003', 'App upload - 2014 Toyota Highlander - 2026-09-18 1942 - Maya.pdf', 1,
    'maya@example.com', ['2026-09-18', '19:42'], 'Needs attention', null, null, ['2026-09-19', '07:30']),
  scan('scan-0004', 'Owner entry', TL, 'fake-scan-0004',
    'App owner entry - 2025 Kia Telluride SX Prestige - 2026-09-20 1015 - Nina.pdf', 1,
    'nina@example.com', ['2026-09-20', '10:15'], 'Adding to journal', null, null, ['2026-09-22', '07:30']),
  scan('scan-0005', 'Receipt', X7, 'fake-scan-0005', 'App scan - 2023 BMW X7 - 2026-09-10 1230 - Robert.pdf', 2,
    'robert@example.com', ['2026-09-10', '12:30'], 'Check with owner', 'The file is no longer in Drive.', null,
    ['2026-09-11', '13:00']),
  scan('scan-0006', 'Receipt', JP, 'fake-scan-0006', 'App scan - 2016 Jeep Wrangler - 2026-09-19 0905 - Robert.pdf', 4,
    'robert@example.com', ['2026-09-19', '09:05'], 'Needs attention', null, null, ['2026-09-20', '07:30']),
  // Older than 30 days: not in My scans or the attention banner.
  scan('scan-0007', 'Receipt', HL, 'fake-doc-hl-1202-inv', 'App scan - 2014 Toyota Highlander - 2026-08-20 1100 - Maya.pdf', 1,
    'maya@example.com', ['2026-08-20', '11:00'], 'Filed', null, 'hl-20251202-R1008', ['2026-08-20', '15:00']),
  scan('scan-0008', 'Receipt', HL, 'fake-scan-0008', 'App scan - 2014 Toyota Highlander - 2026-08-01 0900 - Maya.pdf', 2,
    'maya@example.com', ['2026-08-01', '09:00'], 'Needs attention', null, null, ['2026-08-31', '07:30']),
  // Exactly 30 days old: still listed.
  scan('scan-0009', 'Upload', R4, 'fake-scan-0009', 'App upload - 2023 Toyota 4Runner - 2026-08-23 1640 - Leo.pdf', 1,
    'leo@example.com', ['2026-08-23', '16:40'], 'Check with owner', null, null, ['2026-08-24', '17:00']),
];

const recalls = [
  { 'Vehicle': JP, 'Campaign Number': '26V901000', 'Report Date': d('2026-08-20'), 'Component': 'AIR BAGS:FRONTAL',
    'Summary': 'Sample recall summary.', 'Consequence': 'Sample consequence.', 'Remedy': 'Dealers will replace the part.',
    'Status': 'New', 'First Seen': d('2026-08-21'), 'Park It': 'Yes', 'Park Outside': 'No' },
  { 'Vehicle': JP, 'Campaign Number': '19V902000', 'Report Date': d('2019-01-15'), 'Component': 'ELECTRICAL SYSTEM',
    'Summary': 'Sample recall summary.', 'Status': 'Reviewed', 'First Seen': d('2026-08-21'),
    'Notes': 'Done at the dealer in 2019' },
  { 'Vehicle': X7, 'Campaign Number': '25V903000', 'Report Date': d('2025-05-02'), 'Component': 'FUEL SYSTEM',
    'Summary': 'Sample recall summary.', 'Status': 'Reviewed', 'First Seen': d('2026-08-21') },
  { 'Vehicle': TL, 'Campaign Number': '26V905000', 'Report Date': d('2026-03-03'), 'Component': 'SEAT BELTS',
    'Summary': 'Sample recall summary.', 'Status': 'Not applicable', 'First Seen': d('2026-08-21') },
  { 'Vehicle': TL, 'Campaign Number': '26V904000', 'Report Date': d('2026-09-10'), 'Component': 'ELECTRICAL SYSTEM',
    'Summary': 'Sample recall summary.', 'Consequence': 'Sample consequence.', 'Remedy': 'Software update.',
    'Status': 'New', 'First Seen': d('2026-09-12'), 'Park Outside': 'Yes' },
];

const pushSubscriptions = [
  { 'Email': 'robert@example.com', 'Endpoint': 'https://push.example.com/send/robert-phone',
    'Keys': '{"p256dh":"BFakeP256dhKey","auth":"fakeAuthSecret"}', 'Device Label': 'iPhone',
    'Created At': dt('2026-09-01', '10:00'), 'Last Success': dt('2026-09-20', '07:31'), 'Active': 'Yes' },
  { 'Email': 'leo@example.com', 'Endpoint': 'https://push.example.com/send/leo-phone', 'Keys': 'not json',
    'Device Label': 'iPhone', 'Created At': dt('2026-09-02', '19:00'), 'Active': 'No' },
];

const notificationLog = [
  { 'Key': 'scanreview:scan-0006', 'Email': 'robert@example.com', 'Title': 'A receipt you scanned needs another look',
    'Sent At': dt('2026-09-20', '07:31'), 'Result': 'Sent' },
  { 'Key': 'recall:2025 Kia Telluride SX Prestige:26V904000', 'Email': 'nina@example.com',
    'Title': 'New recall may apply to the Telluride', 'Sent At': dt('2026-09-12', '07:30'), 'Result': 'Sent' },
];

const log = [
  { 'Timestamp': dt('2026-09-21', '12:37'), 'Source': 'queue', 'Level': 'INFO', 'Message': 'Sample log row' },
];

// ---------------------------------------------------------------- assembled tabs

const tabs = {
  'Vehicles': table('Vehicles', vehicles),
  'Visits': table('Visits', visits),
  'Visit Services': table('Visit Services', visitServices),
  'Documents': table('Documents', documents),
  'Recommendations': table('Recommendations', recommendations),
  'Inspection Readings': table('Inspection Readings', readings),
  'Schedule': table('Schedule', schedule),
  'Warranties': table('Warranties', warranties),
  'Service Types': table('Service Types', serviceTypes),
  'Log': table('Log', log),
  'App Users': table('App Users', appUsers),
  'Odometer Readings': table('Odometer Readings', odometerReadings),
  'App Scans': table('App Scans', appScans),
  'Recalls': table('Recalls', recalls),
  'Push Subscriptions': table('Push Subscriptions', pushSubscriptions),
  'Notification Log': table('Notification Log', notificationLog),
};

/** A deep copy of `tabs` (Dates cloned), so a test can change cells freely. */
function cloneTabs(src) {
  const out = {};
  Object.keys(src || tabs).forEach(name => {
    out[name] = (src || tabs)[name].map(row => row.map(v => (v instanceof Date ? new Date(v.getTime()) : v)));
  });
  return out;
}

/**
 * The journal before setupSchemaApply(): only the live columns on Vehicles
 * and Warranties, and none of the app-owned tabs.
 */
function preSetupTabs() {
  const out = {};
  Object.keys(LIVE_HEADERS).forEach(name => {
    const full = tabs[name];
    const keep = LIVE_HEADERS[name].map(h => full[0].indexOf(h));
    out[name] = full.map(row => keep.map(i => (row[i] instanceof Date ? new Date(row[i].getTime()) : row[i])));
  });
  return out;
}

/**
 * The live journal's formulas, cell by cell (A1 → formula), for the
 * preSetupTabs() layout. Same patterns as the real Sheet.
 */
function liveFormulas() {
  const out = { 'Vehicles': {}, 'Schedule': {}, 'Warranties': {} };
  for (let r = 2; r <= vehicles.length + 1; r++) {
    const v = out['Vehicles'];
    const maxifs = (col) => 'IFERROR(IF(MAXIFS(Visits!$' + col + ':$' + col + ',Visits!$B:$B,$A' + r + ')=0,"",' +
      'MAXIFS(Visits!$' + col + ':$' + col + ',Visits!$B:$B,$A' + r + ')),"")';
    v['F' + r] = '=IF(E' + r + '="","",RIGHT(E' + r + ',6))';
    v['N' + r] = '=' + maxifs('C');
    v['O' + r] = '=' + maxifs('D');
    v['P' + r] = '=IFERROR(IF(OR(L' + r + '="",M' + r + '="",N' + r + '="",O' + r + '=""),"",ROUND((O' + r + '-M' + r +
      ')/(N' + r + '-L' + r + '),1)),"")';
    v['Q' + r] = '=IFERROR(IF(OR(O' + r + '="",P' + r + '=""),O' + r + ',ROUND(O' + r + '+P' + r + '*(TODAY()-N' + r +
      '),0)),"")';
    v['R' + r] = '=' + maxifs('K');
    v['S' + r] = '=' + maxifs('L');
  }
  for (let r = 2; r <= schedule.length + 1; r++) {
    const s = out['Schedule'];
    const vs = (col) => "MAXIFS('Visit Services'!$" + col + ":$" + col + ",'Visit Services'!$A:$A,$A" + r +
      ",'Visit Services'!$E:$E,$B" + r + ')';
    s['F' + r] = '=IFERROR(IF(' + vs('C') + '=0,"",' + vs('C') + '),"")';
    s['G' + r] = '=IFERROR(IF(' + vs('D') + '=0,"",' + vs('D') + '),"")';
    s['H' + r] = '=IF(OR(F' + r + '="",C' + r + '=""),"",EDATE(F' + r + ',C' + r + '))';
    s['I' + r] = '=IF(OR(G' + r + '="",D' + r + '=""),"",G' + r + '+D' + r + ')';
    s['J' + r] = '=IFERROR(IF(I' + r + '="","",TODAY()+ROUND((I' + r + '-INDEX(Vehicles!$Q:$Q,MATCH($A' + r +
      ',Vehicles!$A:$A,0)))/INDEX(Vehicles!$P:$P,MATCH($A' + r + ',Vehicles!$A:$A,0)),0)),"")';
    s['K' + r] = '=IF(AND(H' + r + '="",J' + r + '=""),"",IF(H' + r + '="",J' + r + ',IF(J' + r + '="",H' + r +
      ',MIN(H' + r + ',J' + r + '))))';
    s['L' + r] = '=IF(K' + r + '="","No history",IF(K' + r + '<TODAY(),"Overdue",IF(K' + r +
      '-TODAY()<=30,"Due soon","OK")))';
  }
  out['Warranties']['F2'] = '=E2+12000'; // the Gold Certified row; every other End Miles is typed
  return out;
}

module.exports = {
  TODAY,
  tabs,
  users: USERS,
  vehicleNames: { highlander: HL, wrangler: JP, x7: X7, fourRunner: R4, telluride: TL },
  headers: HEADERS,
  liveHeaders: LIVE_HEADERS,
  newVehicleColumns: NEW_VEHICLE_COLUMNS,
  newWarrantyColumns: NEW_WARRANTY_COLUMNS,
  appTabHeaders: APP_TAB_HEADERS,
  cloneTabs,
  preSetupTabs,
  liveFormulas,
  d,
  dt,
};
