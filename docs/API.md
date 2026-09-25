# App API contract

The App API is a standalone Apps Script web app (`apps-script/`). The front end (`web/`) calls it; the typed shapes live in `web/src/api/types.ts`, which is the source of truth. This page explains the behaviour behind each action.

## Transport

- One URL: the web app deployment's `/exec` URL (`apiUrl` in `web/app.config.json`).
- Every call is `POST` with `Content-Type: text/plain;charset=utf-8` and a JSON body: `{"action": "...", ...params}`. Apps Script web apps can't answer CORS preflight requests, so no custom headers are sent. The front end calls `fetch(apiUrl, {method: 'POST', body, redirect: 'follow'})`.
- Every response is HTTP 200 with a JSON body. Apps Script can't set status codes, so failures carry `ok: false` and an HTTP-like `status` (see `ApiError`). The front end treats `status` exactly like an HTTP status.
- `doGet` answers only `?health=1` with `{ok: true, version}`. That lets Andrew check a deployment in the browser. It never returns data.

## Authentication

1. The front end gets a Google ID token and sends `signIn {idToken, nonce}`.
   - It gets the token with a full-page OpenID Connect redirect to `https://accounts.google.com/o/oauth2/v2/auth`, using `response_type=id_token`, `response_mode=fragment`, `scope=openid email profile`, `prompt=select_account`, and a random `state` and `nonce` kept in localStorage.
   - The `redirect_uri` is the app's own URL (`https://anorby515.github.io/VehicleTracker/`).
   - Google's popup and One Tap don't work reliably inside iPhone home-screen apps (see DECISIONS.md), whereas a redirect back into the app's scope returns to the standalone window with the app's own storage.
2. The API verifies the token with Google's `tokeninfo` endpoint, then checks all of these:
   - `aud` equals Script Property `OAUTH_CLIENT_ID`;
   - `iss` is `accounts.google.com` or `https://accounts.google.com`;
   - `exp` is in the future;
   - `email_verified` is true (tokeninfo returns it as the string `"true"`);
   - `nonce` is **required** and must equal the token's nonce (otherwise 401);
   - every claim is compared exactly (strings, no type coercion);
   - the lower-cased `email` is a row on **App Users** with `Active = Yes`.
3. On success it issues an **app session token**: `v1.<base64url(JSON payload)>.<base64url(HMAC-SHA256)>`.
   - The payload is `{e: email, i: issuedAtSec, x: expiresAtSec, n: nonce}`.
   - The token lasts 60 days.
   - The secret is Script Property `SESSION_SECRET`, generated automatically on first use. Deleting that property signs every device out.
4. Every other action (except `pairRedeem`) carries `session`. On every request the API checks the signature and expiry, **and** re-checks that the email is still an Active App Users row. Failures return `401 not_signed_in` or `403 not_family`, and no data.
5. **Rolling renewal:** when a session is more than 7 days old, `bootstrap` also returns a fresh `session` and `sessionExpiresAt`, and the front end replaces the stored token.
6. **Sign-in with a code** (fallback for when the Google button won't work inside the home-screen app):
   - A signed-in device, for example the same phone in Safari, calls `pairCreate`.
   - That returns an 8-character code. The code is stored in CacheService for 10 minutes, is single use, and allows at most 5 wrong attempts per code.
   - A redeemed code must be 8 characters from the code alphabet; anything else counts as a wrong code.
   - After 30 wrong codes in 10 minutes, `pairRedeem` returns `429 rate_limited` for everyone for 10 minutes.
   - The home-screen app sends `pairRedeem {code}` and gets back `SignInResult`.
7. Verified Google ID tokens are cached (CacheService, keyed by a SHA-256 of the token) until they expire, so repeat sign-ins within the hour don't call Google again.

## Actions

| Action | Who | What it does |
| --- | --- | --- |
| `signIn` | anyone | See above. Returns `SignInResult`, or `403 not_family` with the message "This app is for the Norby family." |
| `pairCreate` | session | Returns an 8-character code (`PairCreateResult`). |
| `pairRedeem` | anyone | Exchanges a code for `SignInResult`. Wrong or expired code → `401 not_signed_in`. |
| `bootstrap` | session | Returns everything the app shows (`Bootstrap`). See below. |
| `getFile` | session | Returns a Drive file's bytes (base64). **Only** file IDs that are part of this system; anything else → `403 forbidden`. See Files. |
| `addOdometer` | session | Validates, then appends a row to **Odometer Readings**. Idempotent on `clientId`. |
| `setRecallStatus` | session | Sets one **Recalls** row's Status to `New`, `Done` or `Not applicable` and notes who and when. Returns `{recall}`. |
| `uploadStart` / `uploadChunk` | session | Chunked upload of one PDF into `Inbox` plus a row on **App Scans**. Idempotent on `scanId`. |
| `subscribePush` | session | Upserts a **Push Subscriptions** row (matched on Endpoint), with Active = Yes. |
| `unsubscribePush` | session | Sets Active = No on the row with that endpoint (only if it belongs to the caller). |
| `savePrefs` | session | Writes the JSON into the caller's **App Users › Notification Prefs** cell. |
| `testPush` | session | Sends "Test notification" to all of the caller's active subscriptions, ignoring quiet hours and the daily cap. |
| `signOut` | session | Deactivates the push subscription for `endpoint` if one is given. The token itself simply stops being used; the front end deletes it. |

### bootstrap

- The API reads every tab it needs once, by **header name**, and builds `Bootstrap`.
- The vehicle-wide part is the same for every family member. It is cached in CacheService for up to 5 minutes (gzipped and split across keys, because of the 100 KB value limit).
- Per-user parts are added on top of the cached part on every call: `user`, `myScans`, `Vehicle.isMine` and `Vehicle.attention`.
- Before building, the API runs the **scan status check** for this user's scans that aren't final, throttled to once per 2 minutes per user. That is the "on demand when the app opens" check.

#### How the vehicle-wide values are derived

`apps-script/Logic.js` holds these as pure functions, with unit tests in `apps-script/test/`.

- **Vehicles shown:** Vehicles rows with `Active = Yes`, in tab order.
- **Estimated mileage:** Est. Current Mileage, Avg Miles/Day and Latest Odometer come straight from the Sheet. The API never recalculates due dates or mileage estimates.

**Upcoming** is built from these sources:

- **Schedule rows** for the vehicle:
  - Status = `No history` rows go to `noHistory`.
  - Every other row goes to `upcoming`, with `dueBy` = Due By, `dueMiles` = Next Due Miles, and `status` = the Sheet's Status (`OK`, `Due soon`, `Overdue`).
  - `lastDoneVisitId` is the Visit ID of the Visit Services row with the same Vehicle, Service Type, Date = Last Done Date, and Mileage = Last Done Miles. If no row matches, it falls back to the same Date only.
- **Dealer's next service:** from Vehicles Dealer Next Due Date / Miles.
  - Shown when set and not more than 90 days in the past. When only miles are set, it is shown unless the estimated mileage is past them by more than 90 days' worth of Avg Miles/Day.
  - `dueBy` is whichever comes first: the date, or `today + (miles − est) / avg`.
  - Status: `Overdue` if `dueBy` < today or est ≥ miles; `Due soon` if within 30 days; otherwise `OK`.
- **Recommendations** with Status `Open` or `Watch`:
  - `Open` gets the status `Declined` and the subtitle "Declined at last visit" plus the estimate. `Watch` gets `Watch` and "Keep an eye on".
  - `serviceType` is matched from the Item text against Service Types names and Receipt Synonyms. The longest match wins; if nothing matches, it is null.
- **Warranties** ending within 90 days:
  - `endsOn` = the earlier of End Date and the date End Miles is reached (from Avg Miles/Day).
  - Status: `Due soon` if within 30 days, otherwise `OK`.
- **Registration** expiring within 60 days: `Overdue` if already expired, `Due soon` if within 30 days, otherwise `OK`.
- **Recalls** with Status `New`: status `Recall`, and no `dueBy`.

**Upcoming sort order:**

1. Overdue first.
2. Then by `dueBy` ascending.
3. Undated items (recommendations, recalls) after dated items, in this order: Declined, Recall, Watch.
4. Ties broken by title.

**Coverage:**

- A plan is active if both hold:
  - it has no End Date, or today is before the End Date;
  - it has no End Miles, or Est. Current Mileage is below End Miles.
- `coveredBy` on an Upcoming row lists the active plans whose `Covers` contains the row's `serviceType` (case-insensitive) or is `All`.

**Visits:**

- Sorted newest first by Date, then by Mileage.
- `sourceTag` depends on Source:
  - `CarFax` → CarFax;
  - `Owner-reported` or `Owner journal` → Owner;
  - `Purchase` → Purchase;
  - `Receipt` or anything else → null.
- `beforeOwnership` is true when Date is before Purchase Date.

**Costs:**

- Spend is the sum of Visits Invoice Total where Source isn't `Purchase` and Date is on or after Purchase Date.
- This year, last 12 months (`today − 365 days` up to `today`) and since purchase all use that sum.
- Cost per mile is spend ÷ (Latest Odometer − Purchase Mileage).
- `visitsWithoutTotal` counts the visits in that same set that have a blank Invoice Total.
- `byServiceType` sums Visit Services Line Cost for those same visits.

**Wear:**

- Reads the Inspection Readings rows whose Item starts with `Tread` or `Brake Pad`. The axle comes from `Front` or `Rear` in the Item.
- Tread uses the lowest value per visit across all wheels. Brakes use the lowest front and the lowest rear per visit.
- Replacement points are named constants: tread 4/32 in, brake pads 3 mm.
- **Projection:**
  - Take the readings since the last increase, since a replacement resets the series.
  - With two or more readings at different mileages, fit a least-squares line of value against mileage.
  - If the line is falling, project the mileage where it reaches the replacement point, and the date using Avg Miles/Day.
  - With one reading, the note is "One reading so far". A flat or rising line gives "Not wearing measurably yet".

**Attention** (per user):

- Scans the user uploaded with status `Needs attention` whose vehicle hint (or filed vehicle) is this vehicle.
- Recalls with Status `New`.
- Registration within 60 days.
- The odometer nudge, only when the user is the vehicle's primary driver and there has been no visit with mileage and no odometer reading in the last 60 days.

### Files (`getFile`)

A file ID is allowed only if it appears in one of these places:

- Documents › Drive File ID;
- App Scans › Drive File ID;
- Vehicles › Photo File ID;
- Vehicles › Registration File ID.

The check reads those columns fresh. Only a positive check ("this ID is ours") is cached, for 5 minutes, so a newly added ID works immediately. Anything else gets `403 forbidden`, even if the file exists.

- `purpose: 'photo'` returns the original bytes when the file is ≤ 1.5 MB. Otherwise it returns a Drive thumbnail at 1,200 px wide.
- Files over 20 MB return `413 too_large`, and the app offers "Open in Google Drive" instead.

### addOdometer

The steps, in order:

1. `vehicle` must be an active vehicle, and `mileage` a whole number from 1 to 999,999.
2. `date` defaults to today (Chicago) and can't be in the future.
3. If `clientId` already appears in the Reading ID column, return that row. This is the offline-retry path.
4. `latest` is the higher of Vehicles › Latest Odometer and the highest Odometer Readings mileage for the vehicle. If `mileage < latest`, return `409 below_latest` with `detail: {mileage, date}`.
5. If `mileage > Est. Current Mileage + 5,000` and `confirmHigh` isn't set, return `409 confirm_high` with `detail: {estimate}`.
6. Append the row. Reading ID = `clientId`; Entered By = the user's Name; Entered At = now; Date is stored as a date at noon, matching the ingestion script's convention.

### setRecallStatus

`{vehicle, campaignNumber, status}` with `status` one of `New`, `Done`, `Not applicable`. These are the app's **Done**, **Doesn't apply** and **Mark as new** buttons. `Reviewed` stays a value only typed on the Sheet.

1. Find the Recalls row for that vehicle and campaign, or return `404 not_found`.
2. If it already has that status (ignoring case), change nothing.
3. Otherwise set Status and add a line to Notes, keeping what's there: `Marked <status> by <Name> on <YYYY-MM-DD>`.
4. Invalidate the bootstrap cache, so Upcoming and the attention banner drop (or regain) the recall on the next refresh. Any family member may do this.

### Uploads

`uploadStart` takes `{scanId, kind, vehicleHint, size, pages, capturedAt}` and does the following:

1. If `scanId` is already on App Scans and the caller uploaded it, it returns `{done: true, scan}`. That is a retry after a lost response. Another person's scanId, including an upload they still have in progress, gets `403 forbidden`.
2. It validates the upload:
   - `size` is at most 25 MB (26,214,400 bytes) → otherwise `413 too_large`;
   - `pages` is from 1 to 40;
   - `kind` is one of the three kinds;
   - `vehicleHint` is an active vehicle.
3. It builds the file name from the prefix for the kind: `App scan` (Receipt), `App upload` (Upload) or `App owner entry` (Owner entry). The full name is `<prefix> - <Vehicle> - <YYYY-MM-DD HHmm> - <First name>.pdf`. The time is `capturedAt` in Chicago time. If the name is already on App Scans, it appends ` (2)`, ` (3)` and so on.
4. It opens a Drive **resumable upload session** for `{name, parents: [INBOX_FOLDER_ID], mimeType: 'application/pdf'}`, using the script's OAuth token.
5. It stores the session state in CacheService for 6 hours under a random `uploadId`: `{sessionUri, email, scanId, kind, vehicleHint, size, pages, name, received: 0}`.
6. It returns `{uploadId, chunkSize: 2 MiB}`.

`uploadChunk {uploadId, offset, data}` then works like this:

1. Only the user who started the upload may send chunks.
2. `offset` must equal `received`. Otherwise the API returns the current `received` and `done: false`, and the client resends from there.
3. The first chunk must start with `%PDF-`. A `data` field longer than the base64 of one 2 MiB chunk gets `400 bad_request`.
4. The API forwards the bytes to the session URI with `PUT` and `Content-Range: bytes offset-end/size`.
   - Drive answers `308` with a `Range` header while the upload is incomplete; the API updates `received` from that header.
   - On `200`/`201` the Drive file ID is known. The API appends the **App Scans** row (Status `Waiting`, Uploaded At now, Last Checked now) and returns `{done: true, scan}`.
5. The file only appears in Inbox once the upload is complete, so Cowork never sees a partial file.

If a session expires (6 hours) or the phone gives up, the phone starts again with the **same** `scanId`. That is safe, because nothing was written yet.

### Push

- `subscribePush` stores `Keys` as JSON `{"p256dh": "...", "auth": "..."}`, and Device Label as the user agent's short device name (e.g. "iPhone").
- Sending goes through the Push Worker. See `push-worker/README.md` for its contract.
- **Payload:** the API sends `{title, body, url, tag}`, where `url` is an **absolute** in-scope URL (Script Property `APP_URL`, normalized to an absolute `https://…/` with a trailing slash — anything else falls back to the default `https://anorby515.github.io/VehicleTracker/` — plus the hash route). The Worker refuses a `url` that isn't absolute https.
  - The Worker wraps this as a **Declarative Web Push** message: `{"web_push":8030,"notification":{"title","body","navigate","tag","data":{"url"}}}`. iOS 18.4+ shows it without running the service worker and opens `navigate` on tap.
  - On iOS 16.4–18.3 the same JSON reaches the service worker. There the `push` handler must always call `event.waitUntil(showNotification(...))`, even for a malformed payload, because iOS revokes the subscription of a web app that receives a push and shows nothing.
- **Tap handling on older iOS:** `clients.openWindow(url)` often opens the app without navigating. So `notificationclick`:
  1. stores the URL as a *pending deep link*;
  2. posts it to an open window and focuses that window, or otherwise calls `openWindow`.

  The app reads and clears the pending link on start-up and whenever it becomes visible.
- **Worker results:**
  - 404/410 → the subscription gets Active = No.
  - Reason `BadJwtToken`, `BadAuthorizationHeader` or `BadVapidPublicKey` (whatever the status; the Worker returns `reason` parsed from the push service's reply) → a configuration error. The subscription is **kept** and the error is logged.
  - Any other failure writes nothing to Notification Log, so the notification is retried at the next run.
- **Re-subscribe on launch:** iOS never fires `pushsubscriptionchange`. So on every launch the app calls `getSubscription()`, re-subscribes if it's gone while permission is `granted`, and re-posts the subscription when the endpoint changed.

## Jobs (time-driven triggers)

| Function | Schedule | Work |
| --- | --- | --- |
| `jobScanStatus` | every 30 minutes | Check every App Scans row that isn't final and is newer than 30 days (see Scan status). Then send scan notifications, respecting quiet hours and the cap. |
| `jobDaily` | daily, around 7:30 AM Central | Run the recall lookup, then plan and send every notification type, including any held overnight. |

**Scan status**, by where the Drive file is now:

| Where the file is | Status | Label |
| --- | --- | --- |
| Parent is `INBOX_FOLDER_ID` | `Waiting` | "Waiting to be filed" |
| Parent chain reaches a vehicle's Drive Folder ID, and the file ID is on Documents | `Filed` | "Filed on the \<short name>". Visit ID is set. |
| In a vehicle folder but not yet on Documents | `Adding to journal` | "Filed, adding to journal" |
| Parent is `NEEDS_REVIEW_FOLDER_ID` | `Needs attention` | "Needs attention". Detail: "Andrew's been notified. You may be asked to rescan." |
| Trashed or missing, or none of the above after 24 hours | `Check with owner` | "Check with Andrew" |

`Filed` is final. Every other status is re-checked until the scan is 30 days old.

**Notifications:**

- **Planning is pure.** `planNotifications(state, log, now)` returns candidate messages, each with a deterministic key. It is tested in Node.
- **Keys:**
  - `due:<vehicle>:<serviceType>:<dueBy>`
  - `overdue:<vehicle>:<serviceType>:<dueBy>`
  - `dealer:<vehicle>:<date|miles>`
  - `scanfiled:<scanId>`
  - `scanreview:<scanId>`
  - `recall:<vehicle>:<campaign>`
  - `reg:<vehicle>:<expires>`
  - `warranty:<vehicle>:<plan>:<endsOn>`
  - `nudge:<vehicle>:<evidenceDate>:<n>`
- **Filtering:** the send step drops candidates whose key (plus email) is already in Notification Log, and those the recipient's prefs turn off.
- **Quiet hours** run 21:00–07:00 Chicago time. During quiet hours nothing is sent and nothing is logged. The candidates are simply planned again at the next run, and the 7:30 daily run picks them up.
- **Daily cap:**
  - At most 3 notifications per person per Chicago day, counted from Notification Log rows with Result `Sent` or `Bundled` sent today.
  - When more candidates are waiting than the person has left today, the API sends `(remaining − 1)` individually and one bundle for the rest. The bundle reads "N things coming up on the 4Runner" when they're all for one vehicle, or "N updates about your vehicles" otherwise.
  - Every bundled key is logged with Result `Bundled`.
- **Logging:** each individual send is logged with Result `Sent` (at least one device succeeded) or `No device`. A send that fails on every device logs nothing and is retried next run. Endpoints that return 404 or 410 get Active = No.

## Setup functions (run by hand from the Apps Script editor)

- `setupSchema()`: dry run. It lists every change in the Log tab (Source `app-setup`) and changes nothing.
- `setupSchemaApply()`: the same as `setupSchema({apply: true})`. It is provided because the editor's Run button can't pass arguments.
- `installTriggers()`: removes this project's own triggers and installs `jobScanStatus` (every 30 minutes) and `jobDaily` (07:30). It never touches the Sheet-bound project's triggers.
- `checkSetup()`: checks the Script Properties and the Sheet's structure, and writes a readable report to the execution log.

## Deep links (hash routes)

The API builds these for `AttentionItem.href` and push `url`, and the front end routes them. Vehicle names are `encodeURIComponent`-encoded.

| Route | Opens |
| --- | --- |
| `#/v/<vehicle>` | Vehicle card |
| `#/v/<vehicle>/visit/<visitId>` | Visit detail |
| `#/v/<vehicle>/upcoming/<itemId>` | Upcoming row detail (`itemId` = `UpcomingItem.id`, encoded) |
| `#/v/<vehicle>/<panel>` | `basics`, `odometer`, `costs`, `wear`, `registration`, `recalls`, `coverage`, `export` |
| `#/scans` / `#/scans/<scanId>` | My scans / one scan |
| `#/search?q=<text>` | Search |
| `#/settings` | Settings |

Attention hrefs:
- `rescan` → `#/scans/<scanId>`
- `recall` → `#/v/<vehicle>/recalls`
- `registration` → `#/v/<vehicle>/registration`
- `odometer` → `#/v/<vehicle>/odometer`
