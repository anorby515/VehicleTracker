/**
 * The contract between the front end and the App API (apps-script/).
 *
 * This file is the single source of truth for request and response shapes.
 * docs/API.md describes the same contract in prose; apps-script/Config.js
 * mirrors the enums. If you change a shape here, change the API to match and
 * regenerate the mock fixture (`npm run fixture`).
 *
 * Conventions
 * - Calendar dates are strings "YYYY-MM-DD" in America/Chicago. Never parse
 *   them with `new Date(str)` (that is UTC midnight); use lib/dates.ts.
 * - Timestamps are ISO 8601 strings with offset ("2026-09-22T15:29:30-05:00").
 * - Mileage and money are plain numbers. Blank cells are `null`, never "".
 * - The Vehicle name (Vehicles › Vehicle) is the key for a vehicle everywhere.
 */

export type YMD = string;
export type ISODateTime = string;

// ---------------------------------------------------------------- transport

/** Every request: POST, Content-Type text/plain, body = JSON of one of these. */
export type ApiRequest =
  | { action: 'signIn'; idToken: string; /** The nonce the app put in the OIDC request; the API checks the token echoes it. */ nonce: string }
  | { action: 'pairCreate'; session: string }
  | { action: 'pairRedeem'; code: string }
  | { action: 'bootstrap'; session: string }
  | { action: 'getFile'; session: string; fileId: string; purpose?: 'document' | 'photo' }
  | { action: 'addOdometer'; session: string; vehicle: string; mileage: number; date?: YMD; note?: string; clientId: string; confirmHigh?: boolean }
  | { action: 'uploadStart'; session: string; scanId: string; kind: ScanKind; vehicleHint: string; size: number; pages: number; capturedAt: ISODateTime }
  | { action: 'uploadChunk'; session: string; uploadId: string; offset: number; data: string /* base64 */ }
  | { action: 'subscribePush'; session: string; subscription: PushSubscriptionJSONStrict; deviceLabel: string }
  | { action: 'unsubscribePush'; session: string; endpoint: string }
  | { action: 'savePrefs'; session: string; prefs: NotificationPrefs }
  | { action: 'testPush'; session: string }
  | { action: 'signOut'; session: string; endpoint?: string };

export type ApiAction = ApiRequest['action'];

export interface ApiError {
  ok: false;
  /** HTTP-like status. Apps Script cannot set real status codes, so it is carried here. */
  status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500;
  /** Machine-readable code, see ApiErrorCode. */
  error: ApiErrorCode;
  /** Plain-language message safe to show to the family. */
  message: string;
  /** Extra data for some errors (e.g. below_latest carries the latest reading). */
  detail?: Record<string, unknown>;
}

export type ApiErrorCode =
  | 'bad_request'
  | 'not_signed_in'      // 401: missing/expired/invalid session → show sign-in
  | 'not_family'         // 403: Google account not an Active row on App Users
  | 'forbidden'          // 403: e.g. file id not part of this system
  | 'not_found'
  | 'below_latest'       // 409 addOdometer: lower than latest recorded reading
  | 'confirm_high'       // 409 addOdometer: > estimate + 5,000 and confirmHigh not set
  | 'too_large'          // 413 upload over the size limit
  | 'rate_limited'
  | 'server_error';

export type ApiResponse<T> = ({ ok: true } & T) | ApiError;

export interface SignInResult {
  session: string;
  sessionExpiresAt: ISODateTime;
  user: User;
}

export interface PairCreateResult { code: string; expiresAt: ISODateTime }

export interface BootstrapResult {
  bootstrap: Bootstrap;
  /** Present when the server rolled the session forward; replace the stored one. */
  session?: string;
  sessionExpiresAt?: ISODateTime;
}

export interface FileResult {
  fileId: string;
  name: string;
  mimeType: string;
  size: number;
  /** base64 of the bytes (possibly a resized image when purpose = photo). */
  data: string;
}

export interface OdometerResult {
  reading: OdometerReading;
  /** The server's view of the vehicle's mileage after the reading. */
  latestOdometer: number;
  latestOdometerDate: YMD;
}

export interface UploadStartResult {
  /** Opaque id for uploadChunk. Absent when done = true. */
  uploadId?: string;
  /** Bytes per chunk (multiple of 256 KiB). The last chunk may be shorter. */
  chunkSize?: number;
  /** Server already has this scanId (a retry after a lost response): nothing to send. */
  done?: boolean;
  scan?: Scan;
}

export interface UploadChunkResult {
  /** Total bytes the server has accepted so far. */
  received: number;
  done: boolean;
  /** Present when done. */
  scan?: Scan;
}

export interface OkResult { done: true }
export interface PrefsResult { prefs: NotificationPrefs }
export interface TestPushResult { sent: number; failed: number }

/** What PushSubscription.toJSON() returns, with the fields we need made required. */
export interface PushSubscriptionJSONStrict {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
}

// ---------------------------------------------------------------- bootstrap

export interface Bootstrap {
  schemaVersion: 1;
  generatedAt: ISODateTime;
  /** Today's date in America/Chicago on the server when generated. */
  today: YMD;
  user: User;
  /** Active vehicles in Vehicles tab row order. */
  vehicles: Vehicle[];
  /** Canonical names from the Service Types tab, in tab order. */
  serviceTypes: string[];
  /** This user's App Scans rows uploaded in the last 30 days, newest first. */
  myScans: Scan[];
  /** Display name of the system owner (Andrew) for "Check with Andrew" copy. */
  ownerName: string;
}

export interface User {
  email: string;
  /** App Users › Name ("Andrew"). Used in greetings and scan file names. */
  name: string;
  /** App Users › Driver Name ("Andy") — matches Vehicles › Primary Driver. */
  driverName: string;
  /** App Users › Default Vehicle (a Vehicle name). May not be active; fall back to first. */
  defaultVehicle: string | null;
  prefs: NotificationPrefs;
  /** True for the system owner (receives recall/registration/warranty copies). */
  isOwner: boolean;
}

export type NotificationEvent =
  | 'serviceDue'
  | 'serviceOverdue'
  | 'dealerService'
  | 'scanFiled'
  | 'scanNeedsAttention'
  | 'newRecall'
  | 'registration'
  | 'warrantyEnding'
  | 'odometerNudge';

/** Stored as JSON in App Users › Notification Prefs. Missing keys mean "on". */
export type NotificationPrefs = Partial<Record<NotificationEvent, boolean>>;

export interface Vehicle {
  /** Vehicles › Vehicle, e.g. "2023 Toyota 4Runner". The key everywhere. */
  name: string;
  /** Short name for tight spots and notifications ("4Runner", "X7"). Derived from Model. */
  shortName: string;
  year: number | null;
  make: string | null;
  model: string | null;
  vin: string | null;
  plate: string | null;
  /** Vehicles › Primary Driver as written ("Andy"). */
  primaryDriver: string | null;
  /** True when the signed-in user's Driver Name matches Primary Driver. */
  isMine: boolean;
  photoFileId: string | null;
  originalInServiceDate: YMD | null;
  purchaseDate: YMD | null;
  purchaseMileage: number | null;
  /** Vehicles › Est. Current Mileage (Sheet formula; never recomputed here). */
  estMileage: number | null;
  avgMilesPerDay: number | null;
  latestOdometer: number | null;
  latestOdometerDate: YMD | null;
  /** Date of the newest mileage evidence (visit with mileage or odometer reading). */
  lastMileageEvidenceDate: YMD | null;
  basics: VehicleBasics;
  registration: Registration;
  oemApp: OemApp | null;
  /** Dated/undated action items, already sorted (Overdue first, then by dueBy). */
  upcoming: UpcomingItem[];
  /** Schedule rows with Status = No history (collapsed group at the end). */
  noHistory: UpcomingItem[];
  /** Warranties and prepaid plans for this vehicle (active and expired). */
  coverage: CoveragePlan[];
  /** Newest first by Date, then Mileage. */
  visits: Visit[];
  costs: Costs;
  wear: Wear;
  /** All Recalls rows for this vehicle, newest Report Date first. */
  recalls: Recall[];
  /** Attention banner entries for the signed-in user on this vehicle. */
  attention: AttentionItem[];
}

export interface VehicleBasics {
  oilSpec: string | null;
  oilCapacity: string | null;
  oilFilter: string | null;
  engineAirFilter: string | null;
  cabinAirFilter: string | null;
  tireSize: string | null;
  tirePressure: string | null;
  wiperFrontDriver: string | null;
  wiperFrontPassenger: string | null;
  wiperRear: string | null;
  batteryGroup: string | null;
}

export interface Registration {
  expires: YMD | null;
  fileId: string | null;
  /** Days from `today` to expiry (negative when expired); null when not set. */
  daysLeft: number | null;
}

export interface OemApp {
  name: string;
  link: string;
  storeLink: string | null;
}

export type UpcomingKind = 'schedule' | 'dealer' | 'recommendation' | 'warranty' | 'registration' | 'recall';

/** Badge words. Colour always comes with the word (never colour alone). */
export type UpcomingStatus =
  | 'Overdue'     // red
  | 'Due soon'    // amber, within 30 days
  | 'OK'          // neutral
  | 'Watch'       // neutral outline
  | 'Declined'    // neutral outline, "Declined at last visit"
  | 'Recall'      // red outline
  | 'No history'; // grey

export interface UpcomingItem {
  /** Stable id: "<kind>:<vehicle>:<key>". */
  id: string;
  kind: UpcomingKind;
  /** What: "Oil Change", "Dealer's next service", "Front wiper blades". */
  title: string;
  /** Plain-language second line, e.g. "Declined at last visit · $59.98". */
  subtitle: string | null;
  /** When: the date the row is due (Schedule › Due By for schedule rows). */
  dueBy: YMD | null;
  /** At what odometer (Schedule › Next Due Miles for schedule rows). */
  dueMiles: number | null;
  status: UpcomingStatus;
  /** Service Type when known (schedule rows; recommendations matched via Service Types synonyms). */
  serviceType: string | null;
  /** Names of active plans whose Covers includes serviceType (or All). */
  coveredBy: string[];
  schedule?: ScheduleDetail;
  recommendation?: RecommendationRef;
  /** For kind = recall. */
  recall?: { campaignNumber: string };
  /** For kind = warranty. */
  warranty?: { name: string; endsBy: 'date' | 'miles' };
}

export interface ScheduleDetail {
  intervalMonths: number | null;
  intervalMiles: number | null;
  intervalSource: string | null;
  lastDoneDate: YMD | null;
  lastDoneMiles: number | null;
  /** Visit in the journal that last did this service (matched on Visit Services), if found. */
  lastDoneVisitId: string | null;
  nextDueDate: YMD | null;
  nextDueMiles: number | null;
  estDateForMiles: YMD | null;
  /** Schedule › Status as written by the Sheet formula. */
  sheetStatus: string | null;
}

export interface RecommendationRef {
  recId: string;
  status: 'Open' | 'Watch';
  estimate: number | null;
  visitId: string | null;
  date: YMD | null;
  mileage: number | null;
}

export interface CoveragePlan {
  name: string;
  /** Warranties › Type: Warranty, Prepaid plan, Tire warranty (null when not set). */
  type: string | null;
  startDate: YMD | null;
  endDate: YMD | null;
  startMiles: number | null;
  endMiles: number | null;
  /** Estimated date End Miles will be reached (Avg Miles/Day), when End Miles is set. */
  endMilesDate: YMD | null;
  /** Whichever of endDate / endMilesDate comes first. */
  endsOn: YMD | null;
  endsBy: 'date' | 'miles' | null;
  /** Parsed Covers: service types, or ['All']. Empty when Covers is blank. */
  covers: string[];
  active: boolean;
  notes: string | null;
}

export type SourceTag = 'CarFax' | 'Owner' | 'Purchase' | null;

export interface Visit {
  visitId: string;
  date: YMD | null;
  mileage: number | null;
  location: string | null;
  /** Visits › RO # — show as "Repair order" in detail views only. */
  roNumber: string | null;
  summary: string | null;
  invoiceTotal: number | null;
  amountPaid: number | null;
  cardSurcharge: number | null;
  dealerNextDueDate: YMD | null;
  dealerNextDueMiles: number | null;
  source: string | null;
  /** Small tag for non-receipt sources (Owner-reported / Owner journal → "Owner"). */
  sourceTag: SourceTag;
  /** Visit dated before the vehicle's Purchase Date. */
  beforeOwnership: boolean;
  /** Long technical notes for Andrew — only behind a "Details" disclosure. */
  notes: string | null;
  services: VisitService[];
  /** PDFs first, then images; within each, Documents tab order. */
  documents: DocumentRef[];
  recommendations: RecommendationRow[];
  readings: InspectionReading[];
}

export interface VisitService {
  serviceType: string | null;
  description: string | null;
  lineCost: number | null;
  notes: string | null;
}

export interface DocumentRef {
  documentType: string | null;
  fileName: string | null;
  fileId: string;
  pages: number | null;
  /** Documents › Complete = "No" → show a "Pages missing" badge. */
  complete: boolean | null;
  notes: string | null;
  /** Guessed from the file name extension: 'pdf' | 'image' | 'other'. */
  kind: 'pdf' | 'image' | 'other';
}

export interface RecommendationRow {
  recId: string;
  item: string | null;
  estimate: number | null;
  status: string | null;
  resolvedByVisit: string | null;
  notes: string | null;
}

export interface InspectionReading {
  item: string | null;
  value: number | null;
  unit: string | null;
  rating: string | null;
}

export interface Costs {
  /** Calendar year of `today`. */
  thisYear: number;
  last12Months: number;
  sincePurchase: number;
  /** sincePurchase ÷ (latestOdometer − purchaseMileage); null when not computable. */
  costPerMile: number | null;
  /** Visits in the since-purchase set with a blank Invoice Total. */
  visitsWithoutTotal: number;
  /** One entry per calendar year from the purchase year to this year (zeros included). */
  byYear: { year: number; total: number }[];
  /** Visit Services Line Cost summed by Service Type (same visit filter), largest first. */
  byServiceType: { serviceType: string; total: number }[];
}

export interface Wear {
  tread: WearItem | null;
  brakeFront: WearItem | null;
  brakeRear: WearItem | null;
}

export interface WearItem {
  label: string;            // "Tire tread", "Front brake pads", "Rear brake pads"
  unit: string;             // "/32 in", "mm"
  replacementPoint: number; // 4 (/32 in) or 3 (mm)
  latest: { value: number; date: YMD | null; mileage: number | null; rating: string | null; visitId: string };
  /** The lowest value per visit, oldest first — the series the chart draws. */
  readings: { value: number; date: YMD | null; mileage: number | null; visitId: string }[];
  /** Projection from the current wear run (readings since the last replacement). */
  projection: { mileage: number; date: YMD | null } | null;
  /** "One reading so far", "Not wearing measurably yet", or null. */
  note: string | null;
}

export type RecallStatus = 'New' | 'Reviewed' | 'Done' | 'Not applicable';

export interface Recall {
  campaignNumber: string;
  reportDate: YMD | null;
  component: string | null;
  summary: string | null;
  consequence: string | null;
  remedy: string | null;
  status: string | null;
  firstSeen: YMD | null;
  notes: string | null;
  /** NHTSA "park it": do not drive until repaired (Recalls › Park It = Yes). */
  parkIt: boolean;
  /** NHTSA "park outside": fire risk, park away from buildings. */
  parkOutside: boolean;
}

export type AttentionKind = 'rescan' | 'recall' | 'registration' | 'odometer';

export interface AttentionItem {
  kind: AttentionKind;
  text: string;
  /** Hash route to open when tapped, e.g. "#/scans/<scanId>". */
  href: string;
}

// ---------------------------------------------------------------- scans

export type ScanKind = 'Receipt' | 'Upload' | 'Owner entry';

/** App Scans › Status values written by the API. */
export type ScanStatus = 'Waiting' | 'Filed' | 'Adding to journal' | 'Needs attention' | 'Check with owner';

export interface Scan {
  scanId: string;
  kind: ScanKind;
  vehicleHint: string | null;
  fileId: string | null;
  fileName: string | null;
  pages: number | null;
  uploadedAt: ISODateTime | null;
  status: ScanStatus;
  /** Friendly one-liner, e.g. "Waiting to be filed", "Filed on the 4Runner". */
  statusLabel: string;
  /** Longer explanation for the scan detail view. */
  statusDetail: string | null;
  /** Visit the scan was filed to, once it is on the Documents tab. */
  visitId: string | null;
  /** Vehicle the file was filed under (from its Drive folder), when known. */
  filedVehicle: string | null;
  lastChecked: ISODateTime | null;
}

export interface OdometerReading {
  readingId: string;
  vehicle: string;
  date: YMD;
  mileage: number;
  enteredBy: string;
  enteredAt: ISODateTime;
  note: string | null;
}

// ---------------------------------------------------------------- push

/**
 * What the App API asks the Worker to send. The Worker wraps it as a
 * Declarative Web Push message (iOS 18.4+ shows it without the service
 * worker), which older iOS versions deliver to the service worker instead:
 *
 *   {"web_push":8030,"notification":{"title","body","navigate":url,"tag","data":{"url":url}}}
 *
 * The service worker must handle both that shape and this plain one.
 */
export interface PushPayload {
  title: string;
  body: string;
  /** ABSOLUTE in-scope URL to open on tap, e.g. "https://anorby515.github.io/VehicleTracker/#/v/2023%20Toyota%204Runner". */
  url: string;
  /** Notifications with the same tag replace each other (where the platform supports it). */
  tag: string;
}
