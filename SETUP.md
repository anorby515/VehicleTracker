# Setting up the Vehicles app

These are Andrew's step-by-step instructions, in the order the build spec lists them (§12). Plan on an evening for steps 1–8, and a weekend afternoon for filling in the Sheet and testing on the phones.

What you'll end up with:

```text
iPhone app (GitHub Pages) ──POST──▶ App API (new Apps Script, runs as you)
                                        │ reads the journal Sheet, writes only its own tabs
                                        │ saves scans as new files in Drive › Inbox
                                        └─▶ Push Worker (Cloudflare) ──▶ iPhones
```

The existing ingestion script, its 15-minute trigger and the Cowork prompts are **not touched** by any step here.

> **Keep the secret values out of the repo.** The repo is public. The OAuth client ID, the App API URL, the Worker URL and the VAPID *public* key are safe to publish; they go in `web/app.config.json`. Everything else stays in Apps Script Script Properties or Cloudflare secrets: the Sheet and folder IDs, family emails, the Worker's shared secret and the VAPID *private* key.

---

## 0. Before the repo goes public: remove the spec from its history

The build spec, with family emails, VINs and Drive IDs, was committed to this repo before we decided to make it public. PR #1 was merged while it was still in the tree. Deleting the file in a later commit doesn't remove it from history, and GitHub keeps every pull request's commits reachable from the PR page even after branches are deleted. The only clean way is to publish the finished code in a **fresh repo** with a single commit.

1. Merge the final pull request so `main` has the finished app.
2. On github.com, open this repo › **Settings** › **General** › **Repository name**. Rename it to `VehicleTracker-private` and click **Rename**. It stays private, keeps the full history, and remains a place to work with Claude Code.
3. Create a new repo: **+** › **New repository** › name `VehicleTracker` › **Public** › don't add a README › **Create repository**.

   The name must be exactly `VehicleTracker`. The app's address, `https://anorby515.github.io/VehicleTracker/`, comes from it, and so does the redirect URI registered with Google in step 2.
4. Push the finished code as a single commit. Use Terminal on your Mac, or ask Claude Code to do it:
   ```sh
   git clone https://github.com/anorby515/VehicleTracker-private.git vt && cd vt
   git rm -q --cached --ignore-unmatch Vehicle-Maintenance-Web-App-Spec.md
   rm -f Vehicle-Maintenance-Web-App-Spec.md
   git checkout --orphan public
   git commit -qm "Vehicles app"
   git push https://github.com/anorby515/VehicleTracker.git public:main
   ```
5. Keep your own copy of the spec in Drive `_System` or Cowork. It is never needed in the repo.

---

## 1. GitHub Pages

1. In the public `VehicleTracker` repo, open **Settings** › **Pages**. Under **Build and deployment**, set **Source** to **GitHub Actions**.
2. Open the **Actions** tab. Enable workflows if GitHub asks.
3. Every push to `main` now runs the tests and publishes the app to `https://anorby515.github.io/VehicleTracker/`.

   The first deploy works before steps 2–7. The app then runs in **demo mode** with made-up data, because `web/app.config.json` has no `apiUrl` yet.

---

## 2. Google Cloud: the sign-in client

The app signs people in with Google once and then keeps its own session for about 60 days. It asks Google only for `openid email profile`.

1. Go to <https://console.cloud.google.com/> signed in with your own Google account (the one that owns the journal Sheet). Use the project picker at the top: **New project** › name `Vehicles app` › **Create**, then select it.
2. Open **☰** › **APIs & Services** › **OAuth consent screen**. The console may call this **Google Auth Platform**. Click **Get started**.
   - **App name:** `Vehicles`. **User support email:** yours. **Audience:** **External**. **Contact email:** yours. Agree and **Create**.
   - On a phone, the section menu (Branding, Audience, Clients, Data Access) is behind the **shield icon ▾** next to "Google Auth Platform".
   - You can skip **Data Access**: `openid`, email and profile are basic scopes, and sign-in works without listing them.
3. **Audience.** Leave the publishing status on **Testing**. Under **Test users** › **Add users**, add the four family Google accounts and **Save**.
   - **Why Testing:** **Publish app** stays greyed out until the Branding page has a home page and a privacy policy link, which this app doesn't have. Testing's 7-day expiry doesn't apply to sign-in-only apps, and the app keeps its own 60-day session anyway.
   - **Who can get in:** a Google account must be a test user here **and** active on the **App Users** tab. Anyone else sees "This app is for the Norby family" and gets no data. A new driver needs adding in both places.
4. Open **Clients** › **Create client** › **Application type: Web application** › **Name** `Vehicles web`.
   - **Authorized JavaScript origins:** add `https://anorby515.github.io`. This is the host only, with no path and no trailing slash.
   - **Authorized redirect URIs:** add `https://anorby515.github.io/VehicleTracker/`. Use exactly that, **with** the trailing slash.
   - Optional, for testing on a computer: also add origin `http://localhost:5173` and redirect `http://localhost:5173/VehicleTracker/`.
   - Click **Create** and copy the **Client ID** (it ends in `.apps.googleusercontent.com`). The client secret isn't used.

---

## 3. Cloudflare: the Push Worker

Apps Script can't do the cryptographic signing Web Push needs, so a small free Cloudflare Worker does it.

**3a. Make the VAPID keys.** Make these once and never change them: changing them breaks every phone's notifications until each phone turns them on again. Use one of these options:
- With Node.js: `npx web-push generate-vapid-keys`
- With OpenSSL (Terminal on a Mac):
  ```sh
  openssl ecparam -name prime256v1 -genkey -noout -out vapid.pem
  echo "Public:";  openssl ec -in vapid.pem -pubout -outform DER 2>/dev/null | tail -c 65 | base64 | tr -d '=\n' | tr '/+' '_-'; echo
  echo "Private:"; openssl ec -in vapid.pem -outform DER 2>/dev/null | tail -c +8 | head -c 32 | base64 | tr -d '=\n' | tr '/+' '_-'; echo
  ```
- With nothing installed: open any web page on a computer, open the browser's developer console, paste this, and press Return:
  ```js
  (async()=>{const k=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign']);const p=new Uint8Array(await crypto.subtle.exportKey('raw',k.publicKey));const j=await crypto.subtle.exportKey('jwk',k.privateKey);const b=u=>btoa(String.fromCharCode(...u)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');console.log({publicKey:b(p),privateKey:j.d})})()
  ```

You get a **public key** (87 characters) and a **private key** (43 characters). Save both in your password manager. The public key goes in the app's config and the Worker; the private key goes **only** into Cloudflare. Don't use online key generators: they would see your private key.

**3b. Make a shared secret.** This is a long random string that proves messages come from the App API. For example:
```sh
openssl rand -base64 32
```

**3c. Deploy the Worker.** Choose one of these:
- *Dashboard, no tools:*
  1. Sign up at <https://dash.cloudflare.com/sign-up>. The free plan is enough.
  2. On the dashboard home, under **Workers**, click **Ship something new** › **Start with Hello World!**. (Older dashboards: **Workers & Pages** › **Create** › **Create Worker**.) Name it `vehicles-push` › **Deploy**.
  3. **Edit code**. Delete the sample and paste the whole of `push-worker/dist/worker.js`. That file is built, not committed: run `npm run bundle` in `push-worker/`, or ask Claude Code for it. Then **Deploy**.
- *Command line:*
  ```sh
  cd push-worker
  npx wrangler login
  npx wrangler deploy
  ```

**3d. Settings.** In the Worker, open **Settings** › **Variables and Secrets** and add:

| Name | Type | Value |
| --- | --- | --- |
| `VAPID_PUBLIC_KEY` | Text | the public key from 3a |
| `VAPID_SUBJECT` | Text | `mailto:` followed by your email address (it must start with `mailto:` or `https:`) |
| `VAPID_PRIVATE_KEY` | **Secret** | the private key from 3a |
| `PUSH_SECRET` | **Secret** | the shared secret from 3b |

With wrangler, use `npx wrangler secret put VAPID_PRIVATE_KEY` and `npx wrangler secret put PUSH_SECRET`, and edit the `[vars]` in `wrangler.toml`.

**3e. Check it.** Open the Worker's URL (`https://vehicles-push.<your-subdomain>.workers.dev/`) in a browser. It should say `{"ok":true,"service":"vehicles-push"}`. Copy that URL.

---

## 4. The App API (a new, separate Apps Script project)

> **Important:** this is a **new standalone project** at script.google.com. Do **not** open Extensions › Apps Script from inside the Sheet. That is the ingestion script's project and must stay exactly as it is.

1. Go to <https://script.google.com/> › **New project**. Rename it (top left) to `Vehicles App API`.
2. Click **Project Settings** (the gear) and tick **Show "appsscript.json" manifest file in editor**. Also set **Time zone** to `(GMT-06:00) Central Time - Chicago`.
3. Copy the code in. The easiest way is three pastes:
   1. Get the paste files: run `npm run paste` in `apps-script/`, or ask Claude Code for them. You get `paste/Part1.gs`, `Part2.gs`, `Part3.gs` and `appsscript.json`. Together they are every `.js` file in `apps-script/` except the tests.
   2. Back in **Editor**, replace the contents of `appsscript.json` with `paste/appsscript.json`.
   3. Replace the contents of `Code.gs` with `Part1.gs`. Then click **+** › **Script**, name it `Part2`, and paste `Part2.gs`. Do the same for `Part3`. Save.

   *Alternatives:* create one script file per source file (same name without `.js`), or, with Node.js, install [clasp](https://github.com/google/clasp), use `.clasp.json.example`, and run `clasp push`.
4. **Project Settings** › **Script Properties** › **Add script property** for each of these:

| Property | Value |
| --- | --- |
| `SHEET_ID` | The ID in the journal Sheet's URL, between `/d/` and `/edit` |
| `INBOX_FOLDER_ID` | The ID in the Inbox folder's URL (after `/folders/`) |
| `NEEDS_REVIEW_FOLDER_ID` | The ID of `_Needs Review` |
| `OAUTH_CLIENT_ID` | The Client ID from step 2 |
| `PUSH_WORKER_URL` | The Worker URL from step 3e |
| `PUSH_WORKER_SECRET` | The shared secret from step 3b |
| `OWNER_EMAIL` | Your Gmail address. Optional: it defaults to the account that deploys. You get copies of recall, registration and warranty notifications, and the app says "Check with Andrew" |
| `SEED_APP_USERS` | Used once to fill App Users; see below |
| `APP_URL` | Optional. The app's address for notification links; defaults to `https://anorby515.github.io/VehicleTracker/` |

`SESSION_SECRET` is created automatically the first time someone signs in. Deleting it later signs every phone out.

`SEED_APP_USERS` is one line of JSON. Put the real emails in **only here**, never in the repo:

```json
[{"email":"<your Gmail>","name":"Andrew","driverName":"Andy","defaultVehicle":"2023 BMW X7"},{"email":"<Jack's Gmail>","name":"Jack","driverName":"Jack","defaultVehicle":"2023 Toyota 4Runner"},{"email":"<Lila's Gmail>","name":"Lila","driverName":"Lila","defaultVehicle":"2014 Toyota Highlander"},{"email":"<Shauna's Gmail>","name":"Shauna","driverName":"Shauna","defaultVehicle":"2025 Kia Telluride SX Prestige"}]
```

5. In the editor, choose `checkSetup` in the function menu and click **Run**.
   - Google asks for permission the first time: **Review permissions** › pick your account › **Advanced** › **Go to Vehicles App API** › **Allow**. The warning appears because this is your own unverified script.
   - The **Execution log** lists anything missing. Fix it and run again until it's clean.

---

## 5. Record Schedule dates **before** the formula change

`setupSchema()` changes the Avg Miles/Day and Est. Current Mileage formulas (spec §5.3). They now use odometer readings as well as visits. Schedule's "Est. Date for Miles" and "Due By" depend on those formulas, so some dates, and therefore Todoist due dates, will shift slightly. Take a snapshot to compare against:

1. In the journal Sheet, open **File** › **Version history** › **Name current version** and call it `Before vehicles app`.
2. Also select Schedule columns **A** (Vehicle), **B** (Service Type) and **K** (Due By). Copy them, and **Paste special › Values only** into a new, separate Google Sheet named `Schedule before app`.

---

## 6. Run `setupSchema()`: dry run first

1. In the App API editor, choose **`setupSchema`** › **Run**. This is a dry run and **changes nothing** except writing its report to the Log tab.
2. In the journal Sheet, open the **Log** tab and filter **Source = `app-setup`**. You'll see one line per change it *would* make:
   - create the six app tabs;
   - append the new columns on Vehicles and Warranties, at the end;
   - fill Photo File ID for each vehicle, by finding `<Vehicle> - Photo.png/jpg` in its folder;
   - seed App Users;
   - add the Latest Odometer and Latest Odometer Date formulas;
   - replace the two formulas, each with its current text shown.

   If a line says **SKIPPED** because a formula didn't match what's expected, stop and ask Claude Code. It never guesses.
3. When the report looks right, choose **`setupSchemaApply`** › **Run**. This is the same as `setupSchema({apply: true})`, and the Log now says what it **did**.
4. Run **`setupSchema`** once more. The report should say **no changes needed**, which confirms the run is idempotent.
5. **Compare dates.** In `Schedule before app`, put the new Due By values in column D next to the old ones. Paste values from the journal's Schedule A, B and K into columns E to G, then set D2 to `=G2-C2` and fill down. That gives each row's shift in days.
   - Expect small shifts only on rows whose due date comes from miles (Est. Date for Miles).
   - Rows due by date don't move.
   - A shift of weeks means a mileage entry is wrong; check that vehicle's Odometer Readings and Visits.
   - Cowork's Todoist sync picks up the new dates on its next run. Its `[vm:]` keys are unchanged.
6. Check the ingestion script still works. Wait for its next 15-minute run and look at the Log for a normal `queue` line. Or use **Vehicle Maintenance › Process queue now** in the Sheet.

---

## 7. Deploy the App API and install its timers

1. In the App API editor, go to **Deploy** › **New deployment** › click the gear › **Web app**:
   - **Description:** `v1`
   - **Execute as:** **Me** (your account)
   - **Who has access:** **Anyone**. This is needed so phones can reach it; the code itself checks every request against App Users.
   - Click **Deploy** and copy the **Web app URL** (it ends in `/exec`).
2. Open that URL with `?health=1` added, for example `…/exec?health=1`. You should see `{"ok":true,...}`.
3. Choose **`installTriggers`** › **Run**. This adds two timers to *this* project only:
   - the scan-status check every 30 minutes;
   - the daily job around 7:30 AM Central, which runs recalls and notifications.
4. **Updating later:** go to **Deploy** › **Manage deployments** › pencil › **Version: New version** › **Deploy**. That keeps the same URL. Never use "New deployment" again, because that creates a new URL.

---

## 8. Point the app at your services

Edit `web/app.config.json` in the public repo. On github.com you can click the file › pencil:

```json
{
  "oauthClientId": "<Client ID from step 2>",
  "apiUrl": "<Web app URL from step 7>",
  "vapidPublicKey": "<VAPID public key from step 3a>",
  "pushWorkerUrl": "<Worker URL from step 3e>"
}
```

Leave the other keys as they are. Commit to `main`; the Actions tab shows the deploy, and after about 2 minutes the live app uses your data.

---

## 9. Fill in the Sheet

### App Users
Check the four rows `setupSchema` added:
- **Active** = `Yes`.
- **Driver Name** matches Vehicles › Primary Driver exactly. You are `Andy` there, so your Driver Name is `Andy` and your Name is `Andrew`.
- **Default Vehicle** is spelled exactly as on Vehicles.

To add a driver later, add a row. To remove someone, set Active = `No`; that takes effect on their next request.

### Vehicles
- **Highlander › Purchase Mileage:** enter `7` (delivery miles). Blank Purchase Mileage leaves Avg Miles/Day blank. The Highlander's estimate then never moves forward on its own, its Schedule rows get no mileage-based date, and cost per mile can't be computed. You may also want to update its Notes, which currently say purchase mileage is unknown.
- **Vehicle Basics** (Oil Spec … Battery Group): check each value against the **owner's manual**, not the receipts. Receipts give hints only:

  | Vehicle | Seen on receipts |
  | --- | --- |
  | Highlander | 0W-20, 245/55R19 |
  | 4Runner | 0W-20 |
  | Telluride | 5W-30 |
  | Jeep | 5W-20 |

  Blank cells show "Not set" in the app.
- **Photo File ID:** should already be filled by setupSchema. To change a photo, put a JPG or PNG in the vehicle's folder root and paste its ID here. Wide side-profile shots with transparent backgrounds look best.
- **Registration Expires** (a date) and **Registration File ID** (the ID of the scanned registration in Drive).
- **NHTSA Make / NHTSA Model**, used for the recall lookup. NHTSA matches these exactly:

  | Vehicle | NHTSA Make | NHTSA Model |
  | --- | --- | --- |
  | 2014 Toyota Highlander | `TOYOTA` | `HIGHLANDER` |
  | 2016 Jeep Wrangler | `JEEP` | `WRANGLER` (not "Wrangler Unlimited") |
  | 2023 BMW X7 | `BMW` | `X7` |
  | 2023 Toyota 4Runner | `TOYOTA` | `4RUNNER` |
  | 2025 Kia Telluride SX Prestige | `KIA` | `TELLURIDE` |

- **OEM App Name / Link / Store Link**, for the BMW, Telluride and 4Runner. See [OEM app links](#oem-app-links) below and test each one on your iPhone.

### Warranties
- Add **Type** (`Warranty`, `Prepaid plan` or `Tire warranty`) and **Covers** to every row. Covers is a comma-separated list of Service Types exactly as on the Service Types tab (e.g. `Oil Change, Tire Rotation`), or `All`.
  - A bumper-to-bumper warranty covers repairs, not maintenance. So leave out Oil Change and Tire Rotation unless the plan pays for them; otherwise the app will say "Covered" on oil changes.
- Add the missing rows:
  - Telluride 10-year/100k powertrain;
  - Telluride 5-year/60k basic;
  - the BMW prepaid maintenance plan (Type `Prepaid plan`, Covers e.g. `Oil Change, Cabin Air Filter, Engine Air Filter, Brake Fluid`, per the contract);
  - the Costco tire warranty on the Highlander (Type `Tire warranty`, Covers `Tires, Tire Rotation`, per the contract).
- A plan counts as active until its End Date or End Miles, whichever comes first. Blank limits don't count.

---

## 10. Wrap-up

1. **Drive `_System`:** save a copy of `docs/DATA_CONTRACT.md` and a copy of the Cowork scheduled-task instructions.
2. **Scanner quality gate** (spec §7.4). Scan 10 real receipts with the app, including:
   - one crumpled;
   - one faded thermal-paper;
   - one glossy;
   - one on a busy background;
   - one multi-page invoice.

   Pass means all of these:
   - edges found without adjusting on at least 8 of 10;
   - every page fixable with the corner handles;
   - text legible at 100%;
   - **Cowork files every one without sending it to review for readability.**

   If it fails, tell Claude Code to "swap the scanner order". The Google Drive scanner then becomes the main button, and the built-in one becomes "Try the quick scanner".
3. **Install on each family iPhone** (iOS 16.4 or later):
   1. Open `https://anorby515.github.io/VehicleTracker/` in **Safari**.
   2. Tap **Share** › **Add to Home Screen** › **Add**.
   3. Open **Vehicles** from the home screen, not Safari, and tap **Sign in with Google**. The home-screen app has its own sign-in, separate from Safari's, so this is needed once per phone even if Safari is already signed in.
   4. Tap **Turn on notifications** › **Allow**. Then **Settings** › **Send a test notification**.

   If Google's page can't finish inside the home-screen app, use the code instead. Sign in to the site in Safari, open **Settings** › **Sign in on another device** to get a code, then in the home-screen app tap **Use a sign-in code**.

---

## OEM app links

Manufacturers don't publish their URL schemes, and they change. So the links are data in the Sheet, not code. Test each candidate on your iPhone:
1. Put it in **OEM App Link**.
2. Wait up to 5 minutes, or pull to refresh in the app.
3. Tap **Open …**.

If the app opens, keep it. If iOS says the address is invalid, try the next candidate. If none work, leave **OEM App Link** set to the App Store link: tapping the button then opens the App Store page, and from there **Open**.

| Vehicle | App | OEM App Name | OEM App Link: candidates to try, most likely first | OEM App Store Link |
| --- | --- | --- | --- | --- |
| 2023 BMW X7 | My BMW (US) | `My BMW` | 1. `de.bmw.connected.mobile20.na://` 2. `com.bmw.connected://` | `https://apps.apple.com/us/app/my-bmw/id1519457734` |
| 2025 Kia Telluride | Kia Access (formerly Kia Connect / UVO) | `Kia Access` | 1. `com.myuvo.link://` 2. `myuvo://` 3. `kiaaccess://` (all unconfirmed) | `https://apps.apple.com/us/app/kia-access/id1280548773` |
| 2023 Toyota 4Runner | Toyota | `Toyota` | 1. `com.toyota.oneapp://` 2. `oneappfrnative.toyota://` | `https://apps.apple.com/us/app/toyota/id1455685357` |

About these candidates:
- The App Store links are reliable.
- The app schemes are educated guesses. BMW's and Toyota's come from each app's bundle ID and its sign-in redirect; Kia had no evidence at all. None of the manufacturers publish them.
- A candidate that doesn't work makes iOS show "Safari cannot open the page because the address is invalid". That's harmless; try the next one.
- The app always shows the App Store link as well, so a wrong scheme never strands anyone.

---

## Acceptance checklist (spec §13)

Tick these on a real iPhone installed to the home screen.

**Access**
- [ ] Each of the four accounts signs in and opens on its default vehicle (Andrew on the BMW X7).
- [ ] Any other Google account sees the "family only" screen, and the API returns no data to it.
- [ ] The API refuses a document request for a Drive file ID that isn't part of this system. This one is covered by an automated test; to check by hand, ask Claude Code.

**Viewing**
- [ ] Swiping moves through all five active vehicles. Each shows its photo, name, plate and estimated mileage.
- [ ] The 4Runner's Upcoming shows:
  - its Schedule rows, with dates and miles matching the Sheet exactly;
  - the dealer service (Dec 25, 2026 / 40,000 mi);
  - the Watch items for tires, brakes and filters;
  - the Gold Certified warranty as coverage.
- [ ] The Highlander's Journal lists visits newest first, starting with 2025-12-02 Toyota of Des Moines, and each visit opens its services and receipt.
- [ ] The BMW's pre-ownership CarFax visits carry "Before we owned it".
- [ ] Vehicle Basics, Costs, Wear, Registration, Recalls, Search and Export all show correct data for at least one vehicle each.
- [ ] The OEM app button opens the installed app, or the App Store fallback works.

**Scanning**
- [ ] A three-page receipt scanned in the app arrives in `Inbox` as one PDF. Its status moves from Waiting to Filed, with a link to the new visit, after Cowork's next run.
- [ ] A scan made in airplane mode uploads automatically when back online.
- [ ] The scanner quality gate (step 10.2) passes.
- [ ] One "Work I did myself" entry reaches `Inbox`. Note what Cowork did with it.

**Odometer and notifications**
- [ ] An odometer reading lands on Odometer Readings and moves that vehicle's Est. Current Mileage.
- [ ] A test notification reaches each installed phone, and tapping it opens the right screen. Quiet hours (9 PM–7 AM) and the 3-per-day cap hold.

**Offline and no drift**
- [ ] With no connection, the app opens and shows the last data with the offline banner.
- [ ] After `setupSchemaApply`, the ingestion script's next queue run succeeds, Cowork's next scheduled run files a receipt normally, and Todoist tasks keep their `[vm:]` keys. The ingestion script's code and trigger are unchanged.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Google says `redirect_uri_mismatch` | The redirect URI in step 2 isn't exactly `https://anorby515.github.io/VehicleTracker/` | Fix it in Google Cloud › Clients, including the trailing slash |
| "This app is for the Norby family" for a family member | Their email isn't an Active row on App Users (check spelling and that it's the Gmail they signed in with) | Fix the row; no redeploy needed |
| App says it can't reach the server | Wrong `apiUrl`, or the deployment isn't set to "Anyone" | Step 7; open `…/exec?health=1` |
| Notifications never arrive | App not opened from the home screen, permission denied in iOS Settings › Notifications › Vehicles, or Worker secrets wrong | Re-run step 10.3; check the Worker URL shows `ok`; check `PUSH_WORKER_URL`/`PUSH_WORKER_SECRET` |
| A scan stays "Waiting to be filed" for a day | Cowork hasn't run, or can't read it | Check the Inbox and Cowork; the status updates itself every 30 minutes |
| Scan says "Check with Andrew" | The file was moved somewhere other than a vehicle folder or `_Needs Review`, or deleted | Find it in Drive by name |
| Recalls never appear for a car | NHTSA Make/Model misspelled (NHTSA returns "no recalls" rather than an error) | Use the exact names in step 9 |

## Updating later

- **Front end:** commit to `main`; GitHub Actions tests and deploys. Phones show "New version available. Tap to refresh."
- **App API:** run `npm run paste` in `apps-script/` (or ask Claude Code) and replace the contents of `Code.gs`, `Part2` and `Part3` with the new parts. If it now makes a different number of parts, add or delete files to match. Then Deploy › Manage deployments › edit › **New version**, which keeps the same URL. If `appsscript.json` scopes change, run any function once to re-authorize.
- **Push Worker:** paste the new `dist/worker.js` in the dashboard, or run `npx wrangler deploy`.
- **New vehicle:** add a Vehicles row (Active = Yes) with its Drive folder. Then run `setupSchemaApply` once, which fills its Latest Odometer formulas and photo. Also fill NHTSA Make/Model.
- **New driver:** add their Google account under **Test users** in Google Cloud (step 2.3) and a row on **App Users** (Active = Yes).
