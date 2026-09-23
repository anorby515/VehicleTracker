/**
 * Vehicle Maintenance App API — configuration and schema constants.
 *
 * This is a STANDALONE Apps Script project. It opens the journal Sheet by ID
 * (Script Property SHEET_ID) and is never added to the script bound to the
 * Sheet. Every tab is read by header name, never by column position.
 *
 * Nothing secret lives in this file: Sheet and folder IDs, the OAuth client
 * ID, the Push Worker URL and secret are Script Properties (see SETUP.md).
 */

const APP_VERSION = '1.0.0';
const TZ = 'America/Chicago';

/** Script Property names. */
const PROP = {
  SHEET_ID: 'SHEET_ID',
  INBOX_FOLDER_ID: 'INBOX_FOLDER_ID',
  NEEDS_REVIEW_FOLDER_ID: 'NEEDS_REVIEW_FOLDER_ID',
  OAUTH_CLIENT_ID: 'OAUTH_CLIENT_ID',
  PUSH_WORKER_URL: 'PUSH_WORKER_URL',
  PUSH_WORKER_SECRET: 'PUSH_WORKER_SECRET',
  SESSION_SECRET: 'SESSION_SECRET',   // generated on first use if missing
  OWNER_EMAIL: 'OWNER_EMAIL',         // optional; defaults to the deploying account
  SEED_APP_USERS: 'SEED_APP_USERS',   // JSON, read once by setupSchema when App Users is empty
  APP_URL: 'APP_URL',                 // optional; default DEFAULT_APP_URL (for notification links)
};

/** Journal tabs the app only ever READS (see docs/DATA_CONTRACT.md). */
const TAB = {
  VEHICLES: 'Vehicles',
  VISITS: 'Visits',
  VISIT_SERVICES: 'Visit Services',
  DOCUMENTS: 'Documents',
  RECOMMENDATIONS: 'Recommendations',
  INSPECTION_READINGS: 'Inspection Readings',
  SCHEDULE: 'Schedule',
  WARRANTIES: 'Warranties',
  SERVICE_TYPES: 'Service Types',
  LOG: 'Log',
  // App-owned tabs (the API reads and writes these).
  APP_USERS: 'App Users',
  ODOMETER_READINGS: 'Odometer Readings',
  APP_SCANS: 'App Scans',
  RECALLS: 'Recalls',
  PUSH_SUBSCRIPTIONS: 'Push Subscriptions',
  NOTIFICATION_LOG: 'Notification Log',
};

/** Tabs the API is allowed to write rows to. Anything else is read-only. */
const APP_OWNED_TABS = [
  TAB.APP_USERS, TAB.ODOMETER_READINGS, TAB.APP_SCANS,
  TAB.RECALLS, TAB.PUSH_SUBSCRIPTIONS, TAB.NOTIFICATION_LOG,
];

/**
 * Headers for the app-owned tabs, in order. setupSchema creates these tabs and
 * appends any missing header at the end; it never reorders.
 * App Users adds "Driver Name" after the spec's five columns (see DECISIONS.md).
 */
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

/** New columns appended to existing tabs by setupSchema (section 5.2), in order. */
const NEW_VEHICLE_COLUMNS = [
  'Photo File ID', 'Oil Spec', 'Oil Capacity', 'Oil Filter', 'Engine Air Filter', 'Cabin Air Filter',
  'Tire Size', 'Tire Pressure', 'Wiper Front Driver', 'Wiper Front Passenger', 'Wiper Rear',
  'Battery Group', 'Registration Expires', 'Registration File ID', 'NHTSA Make', 'NHTSA Model',
  'OEM App Name', 'OEM App Link', 'OEM App Store Link', 'Latest Odometer', 'Latest Odometer Date',
];
const NEW_WARRANTY_COLUMNS = ['Type', 'Covers'];

/** Number formats setupSchema applies to the columns it creates. */
const NEW_COLUMN_FORMATS = {
  'Registration Expires': 'yyyy-mm-dd',
  'Latest Odometer': '#,##0',
  'Latest Odometer Date': 'yyyy-mm-dd',
  // App-owned tabs
  'Date': 'yyyy-mm-dd',
  'Mileage': '#,##0',
  'Entered At': 'yyyy-mm-dd hh:mm',
  'Uploaded At': 'yyyy-mm-dd hh:mm',
  'Last Checked': 'yyyy-mm-dd hh:mm',
  'Report Date': 'yyyy-mm-dd',
  'First Seen': 'yyyy-mm-dd',
  'Created At': 'yyyy-mm-dd hh:mm',
  'Last Success': 'yyyy-mm-dd hh:mm',
  'Sent At': 'yyyy-mm-dd hh:mm',
};

/** Business rules kept as named constants. */
const RULES = {
  TREAD_REPLACE_32NDS: 4,          // tire tread replacement point, /32 in
  BRAKE_PAD_REPLACE_MM: 3,         // brake pad replacement point, mm
  DUE_SOON_DAYS: 30,
  DEALER_PAST_GRACE_DAYS: 90,
  WARRANTY_WINDOW_DAYS: 90,
  REGISTRATION_WINDOW_DAYS: 60,
  ODOMETER_NUDGE_DAYS: 60,
  ODOMETER_CONFIRM_ABOVE_EST: 5000,
  SCAN_MISSING_AFTER_HOURS: 24,
  SCAN_TRACK_DAYS: 30,
  MY_SCANS_DAYS: 30,
  NOTIFY_SERVICE_DUE_DAYS: 14,
  NOTIFY_DEALER_DAYS: 14,
  NOTIFY_DEALER_MILES: 500,
  NOTIFY_REGISTRATION_DAYS: [60, 30], // Registration row notifications (spec 8.8/9.2)
  NOTIFY_WARRANTY_DAYS: 30,
  QUIET_START_HOUR: 21,            // 9 PM Central
  QUIET_END_HOUR: 7,               // 7 AM Central (daily run is ~7:30)
  MAX_NOTIFICATIONS_PER_DAY: 3,
  SESSION_TTL_DAYS: 60,
  SESSION_RENEW_AFTER_DAYS: 7,
  PAIR_CODE_TTL_SEC: 600,
  PAIR_CODE_MAX_ATTEMPTS: 5,
  BOOTSTRAP_CACHE_SEC: 300,
  SCAN_CHECK_THROTTLE_SEC: 120,
  UPLOAD_MAX_BYTES: 25 * 1024 * 1024,
  UPLOAD_MAX_PAGES: 40,
  UPLOAD_CHUNK_BYTES: 2 * 1024 * 1024,   // multiple of 256 KiB (Drive resumable rule)
  FILE_MAX_BYTES: 20 * 1024 * 1024,
  PHOTO_MAX_ORIGINAL_BYTES: 1.5 * 1024 * 1024,
  PHOTO_WIDTH: 1200,
};

/** Values the Sheet uses, matched case-insensitively after trimming. */
const VALUES = {
  ACTIVE_YES: 'yes',
  SOURCE_PURCHASE: 'purchase',
  REC_OPEN: 'open',
  REC_WATCH: 'watch',
  SCHEDULE_NO_HISTORY: 'no history',
  RECALL_NEW: 'new',
  COVERS_ALL: 'all',
};

/** Scan statuses written to App Scans › Status (mirrors ScanStatus in web/src/api/types.ts). */
const SCAN_STATUS = {
  WAITING: 'Waiting',
  FILED: 'Filed',
  ADDING: 'Adding to journal',
  NEEDS_ATTENTION: 'Needs attention',
  CHECK_WITH_OWNER: 'Check with owner',
};

const SCAN_KIND_PREFIX = {
  'Receipt': 'App scan',
  'Upload': 'App upload',
  'Owner entry': 'App owner entry',
};

/** Notification event keys (mirrors NotificationEvent in web/src/api/types.ts). */
const NOTIFY_EVENTS = [
  'serviceDue', 'serviceOverdue', 'dealerService', 'scanFiled', 'scanNeedsAttention',
  'newRecall', 'registration', 'warrantyEnding', 'odometerNudge',
];

const DEFAULT_APP_URL = 'https://anorby515.github.io/VehicleTracker/';

const NHTSA_RECALLS_URL = 'https://api.nhtsa.gov/recalls/recallsByVehicle';
const NHTSA_VIN_CHECK_URL = 'https://www.nhtsa.gov/recalls'; // ?vin=<VIN> pre-fills the lookup
const GOOGLE_TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo';
const GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];

/** Family name for the "This app is for the <name> family." sign-in message. */
const FAMILY_NAME = 'Norby';
