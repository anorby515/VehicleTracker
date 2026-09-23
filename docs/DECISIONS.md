# Decisions

These are choices the spec left open, and places where the build departs from it on purpose. Where the spec didn't specify something, the rule was to pick the simplest option that works well on iPhone Safari. Each entry says what was chosen and why.

## Hosting and privacy

- **Public repo on GitHub Pages at `https://anorby515.github.io/VehicleTracker/`** (Andrew's choice).
  - The front end uses hash routing (`#/v/...`) so GitHub Pages never returns a 404 on a deep link.
  - Vite's `base` is `/VehicleTracker/`.
- **No personal data in the repo.** The spec itself isn't in the repo. Family emails, VINs, plates, and Sheet and Drive IDs don't appear in code, docs or tests.
  - Seed rows for App Users come from the `SEED_APP_USERS` Script Property.
  - Vehicle photo IDs are found by file name at setup time rather than hard-coded (see Setup).
  - Test fixtures are synthetic, with made-up VINs, IDs, people and amounts.
  - The only values that are published are the ones the spec says are safe: the OAuth client ID, API URL, Worker URL and VAPID public key.

## Sign-in

- **App session token instead of sending a Google ID token with every request** (Andrew's choice).
  - Silent renewal of Google's 1-hour ID token is unreliable inside iPhone home-screen apps, so people would keep being sent back to the sign-in button.
  - Instead the API verifies the Google ID token once, running every check the spec lists (signature and expiry via Google's `tokeninfo`, audience, issuer, `email_verified`, and an Active App Users row).
  - It then issues its own HMAC-signed token, which lasts 60 days and renews itself after 7.
  - The App Users check still runs on **every** request, so setting Active = No locks someone out immediately. Deleting the `SESSION_SECRET` Script Property signs out every device.
- **The Google sign-in is a full-page OpenID Connect redirect, not the Google Identity Services popup or One Tap.**
  - Research (Sep 2026) found GIS popups hang or go blank in iPhone home-screen apps: the opener handshake is lost when iOS opens Google in its in-app browser. Automatic sign-in and One Tap aren't supported on Safari at all.
  - A redirect whose `redirect_uri` is inside the app's scope brings the ID token back in the URL fragment. iOS then closes the in-app browser and reloads the standalone app, which keeps the app's own storage.
  - The app checks `state`, and the API checks `nonce`.
  - It is one code path for Safari tabs, home-screen apps and desktop, and it needs no extra server.
  - Each person signs in to Google once *inside* the home-screen app, because it has its own cookie jar separate from Safari's.
- **Sign in with a code** is a fallback for when Google's button can't finish inside the home-screen app. You sign in in Safari, get an 8-character code, and type it into the app. The code lasts 10 minutes, works once, and allows 5 wrong attempts.
- **tokeninfo instead of local RS256 verification.** `tokeninfo` checks Google's signature and expiry server-side. Apps Script has no RSA-verify primitive, and a sign-in happens once per device every couple of months, so calling Google is simpler and more reliable than hand-rolled RSA.
- **HTTP status codes:** Apps Script can't set them, so every response is 200 with `{ok:false, status:403, ...}`, and the client treats `status` as the real code.

## Data and formulas

- **`Driver Name` column on App Users.** The Vehicles tab says "Andy"; App Users › Name stays "Andrew" for greetings and scan file names, and Driver Name holds "Andy" for matching Primary Driver. It is added as the last column, after the spec's five.
- **Latest Odometer uses the *highest* mileage** across Visits and Odometer Readings. It is dated to the date of that reading. This matches the existing Last Known Mileage formula, which uses `MAXIFS` (the highest, not the most recent).
- **Avg Miles/Day when Purchase Date or Mileage is blank:**
  - The current formula already returns blank in that case, so the new formula returns blank too, which is the same result.
  - The Highlander's Purchase Mileage should be set to 7 (Andrew's answer) so it gets an average (SETUP.md).
- **Est. Current Mileage when Avg Miles/Day is blank** falls back to Latest Odometer. The current formula falls back to Last Known Mileage in the same situation, so this keeps the same shape but uses the better number.
- **Registration notifications at 60 and 30 days.** Spec §8.8 says "60 and 30 days before", while the §9.2 table says 30. The more specific §8.8 wins.

## Uploads

- **Chunked upload through a Drive resumable-upload session that the API opens.**
  - The phone sends 2 MB base64 chunks to the API. The API forwards each one to Drive's resumable session for a new file in `Inbox`.
  - Nothing is written anywhere except that one Inbox file. It only exists once the last byte lands, so Cowork never sees a partial scan.
  - Retries reuse the phone's `scanId`, so a lost response never creates a duplicate.
- **Owner entries are named `App owner entry - <Vehicle> - <YYYY-MM-DD HHmm> - <First name>.pdf`.** The spec names scans and uploads but not owner entries.

## Add Receipt and the scanner

- **OpenCV.js (`@techstark/opencv-js` 4.10) with our own edge detection instead of jscanify** (`web/src/scanner/detect.ts`).
  - jscanify keeps the largest contour, which fails on busy backgrounds and long receipts. Our detector scores several proposals (edges, bright paper, and jscanify's own method), snaps them to straight edges, and falls back to an inset rectangle for the corner handles.
  - OpenCV is a versioned static file (`vendor/opencv/opencv-4.10.0.js`). It loads when the scanner opens, the service worker caches it on first use, and the app prefetches it about 10 seconds after sign-in so it also works offline.
- **pdf-lib builds the PDFs** (JPEG pages about 2,000 px on the long edge, quality 0.8). One picked PDF is uploaded byte-identical.
- **The scanner is an overlay, not a route.** iOS asks for camera permission again when the hash changes. One camera stream serves every page. It is paused while a page is adjusted or the tray is open, and stopped when the flow moves on, closes, or has been idle for a minute.
- **Never lose a scan.** The finished PDF is written to IndexedDB before any network call and deleted only after the API confirms it.
  - A 413, 400 or 409 is permanent: the PDF stays on the phone and My scans offers Delete (and Try again).
  - A 401 or 403 pauses the queue until the next sign-in. Anything else retries after 5 s, 15 s, 1 min, then every 5 min, and also when the phone comes back online or the app returns to the foreground.
  - "N scans waiting to upload" counts everything still on the phone, including permanent failures, so they stay visible.
- **Owner entries get their own confirmation wording** ("Your entry is in the pile…"). The spec's receipt wording mentions rescanning pages, which doesn't apply to them.

## Recalls

- **NHTSA facts (Sep 2026 research).**
  - `ReportReceivedDate` is **DD/MM/YYYY**, so it is parsed explicitly and never with `new Date()`.
  - A model with no recalls comes back as HTTP 400 with a normal `{Count: 0, results: []}` body, which is treated as "none".
  - Model names are exact matches: `4RUNNER`, `TELLURIDE`, `X7`, `HIGHLANDER`, and `WRANGLER` (not "WRANGLER UNLIMITED").
- **Two extra columns on the app-owned Recalls tab: `Park It` and `Park Outside`.** They are added after the spec's columns and hold NHTSA's "do not drive" and "park outside" flags. The 2016 Wrangler's Takata inflator campaign has "park it" set, so the app shows a clear "Do not drive until repaired" warning rather than burying it in the summary.
- **Silent first import per vehicle.**
  - A vehicle with no Recalls rows yet is imported without pushes. Its campaigns are logged on Notification Log as "Silent (first import)" so they're never sent later.
  - This covers the first run and any car added later.
- **VIN check link:** `https://www.nhtsa.gov/recalls?vin=<VIN>`, with the VIN also copied to the clipboard in case the site ignores the parameter.

## Push Worker

- **`VAPID_SUBJECT` is the app's public URL** (`https://anorby515.github.io/VehicleTracker/`), not a `mailto:` address. VAPID allows either, and a URL keeps a personal email out of the public `wrangler.toml`.
- **Per-message results never fail the batch.**
  - `status` is the push service's HTTP status, or `0` when the Worker didn't send (endpoint not on the allowlist, bad keys or payload, network error or timeout).
  - `error` explains any failure. For a push-service rejection it carries that service's reason text, such as Apple's `BadJwtToken`.
  - `gone` is strictly 404/410.
- **Payload is limited to `title`, `body`, `url` and `tag`,** sent as Declarative Web Push (`{"web_push":8030,"notification":{…,"navigate":url,"data":{"url"}}}`, per `docs/API.md`). Other fields are dropped. The 3,000-byte limit applies to that wrapped JSON, where the URL appears twice. Over it, the body is shortened with "…", and then the title if needed. The Worker refuses a `url` that isn't absolute https (result `bad_url`), and every failed result carries `reason` parsed from the push service's reply (e.g. `BadJwtToken`).
- **Redirects from a push service are not followed** (`redirect: 'manual'`), so one can't lead the Worker off the endpoint allowlist. A `3xx` comes back as a failed result.
- **Fails closed.** With `PUSH_SECRET` unset, `/send` returns `500 not_configured`. Bad VAPID settings are reported only to a caller holding the secret.
- **One VAPID JWT per push service per request.** It expires after 12 hours. Most messages go to `web.push.apple.com`, and signing is the costly step against the free plan's CPU budget. Salt and the sender's ECDH key are still new for every message, as RFC 8291 requires.
- **VAPID private keys shorter than 32 bytes are left-padded.** About 1 key in 256 has a leading zero byte, and some generators drop it.
- **The dashboard bundle isn't committed.** `dist/` is git-ignored. `npm run bundle` builds `dist/worker.js` by joining the two source files, with no dependencies. Deploying with wrangler uses `src/` directly.

## Bootstrap derivations

- **Dealer's next service keeps the dealer's own words.** `dueBy` is the earlier of the dealer's date and the day the miles are reached (as API.md says), so the row's subtitle carries what the dealer wrote: "Dealer suggested Dec 25, 2026 or 40,000 mi". With only miles and no Avg Miles/Day, the row is shown undated.
- **"Covered" only on rows with a Service Type.** Dealer, registration, recall and warranty rows, and recommendations that match no Service Type, never show a coverage callout, even for an `All` plan.
- **Blank limits never end a plan.** A plan with End Miles still counts as active while Est. Current Mileage is blank. Warranty-ending rows are only for active plans whose ending falls between today and 90 days out.
- **Registration row until it's renewed.** Any expiry 60 days away or less shows, including one long past (Overdue), until Andrew types the new date.
- **Service Type matching** (for recommendations): whole words, any case, a trailing plural "s" ignored ("Tires" matches "tire"), "&" read as "and". The longest phrase wins; a tie goes to the earlier Service Types row. `Other` and `Unknown` never match.
- **Costs.**
  - Visits without a Date are left out.
  - With no Purchase Date, every dated visit counts and the chart starts at the first visit's year.
  - `byServiceType` drops zero totals and groups a blank Service Type under "Other".
  - Money is summed in whole cents; cost per mile is rounded to 4 decimals.
- **Wear.**
  - A brake pad reading that names neither Front nor Rear is ignored.
  - A run with only one mileage, including right after a replacement, says "One reading so far".
  - The projected date is today + (projected mileage − Est. Current Mileage) ÷ Avg Miles/Day, the same way the Schedule's Est. Date for Miles works. Without an estimate it counts from the latest reading. A projection that has already passed keeps its past date.
- **Odometer nudge** when the newest mileage evidence is more than 60 days old; a reading exactly 60 days ago still counts as recent.
- **Before `setupSchemaApply()`**, a blank Latest Odometer falls back to Last Known Mileage and Last Visit Date.
- **App Scans › Uploaded By holds the uploader's email** (lower case). My scans also match on the Name, for rows typed by hand, and list rows without Uploaded At last.
- **Scan wording.** A Status Detail cell wins; otherwise each status has a default. "Filed on the \<short name>" uses the vehicle of the scan's Visit ID, or else of the Documents row with the same Drive file ID.
- **Short names** are the Model's first word, or its first two words when the first is generic or a single character ("Grand Cherokee", "Model Y", "3 Series").
- **Bootstrap cache.**
  - Only the vehicle-wide part is cached. App Users and App Scans are read fresh on every call, so a deactivated user or a new scan shows at once.
  - A cached part built on an earlier Chicago day is never served, because day counts would be stale.
  - The key includes `APP_VERSION`. The gzipped JSON is split into 90 KB chunks, and a small index is written last.
  - Anything that writes data the shared part shows (odometer readings, recalls) calls `invalidateBootstrapCache_()`.

## Known limits

- **Shared origin.** Every GitHub Pages site under `anorby515.github.io` shares one web origin, so any of them could read this app's stored session. Don't publish untrusted pages on other repos in that account. A custom domain for this app would remove the concern.
- **Not verifiable off-device:** the camera, `takePhoto` quality, torch, HEIC decoding, long-press copy, share sheet, OEM app links, push delivery and notification taps. The automated tests run in iPhone-sized Chromium; SETUP.md's acceptance checklist covers the real iPhone.
