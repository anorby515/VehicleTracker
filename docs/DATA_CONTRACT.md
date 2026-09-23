# Data contract

The Google Sheet "Vehicle Maintenance Journal" and the Drive folders beside it are the single source of truth. Several components read and write them. This page says who writes what, and which component depends on which column, so a change in one place doesn't quietly break another. Andrew keeps a copy in Drive `_System`.

This page was checked against the live Sheet, its formulas, and the ingestion script (`SCRIPT_VERSION 2026-09-22.3`) on 2026-09-22. The live headers matched the build spec exactly.

## Components

| Short name | What it is | Changed by this build? |
| --- | --- | --- |
| **Ingestion** | The Apps Script bound to the Sheet (`processQueue` every 15 minutes, `installTrigger`, `onOpen` and helpers). It applies Cowork's queue JSON to the Sheet. | **No.** Code and trigger are unchanged. |
| **Cowork** | Claude Cowork scheduled tasks: file receipts from `Inbox` (write queue JSON, rename and move the file), Todoist sync, weekly driver emails. | **No.** Prompts are unchanged. |
| **Formulas** | Formulas in the Sheet (Vehicles, Schedule, one on Warranties). | Only Avg Miles/Day and Est. Current Mileage change, plus two new formula columns (§5.3). |
| **App API** | The new standalone Apps Script project (`apps-script/`). It opens the Sheet by ID. | New. |
| **App** | The iPhone web app (`web/`). It never touches the Sheet directly; everything goes through the App API. | New. |
| **Andrew** | Hand edits. | — |

## Who writes what

| Tab or folder | Written by | App API access |
| --- | --- | --- |
| Visits, Visit Services, Documents, Recommendations, Inspection Readings | Ingestion (from Cowork's queue) | Read only |
| Log | Ingestion; `setupSchema()` also appends its report here with Source `app-setup` | Reads nothing; `setupSchema()` appends only |
| Schedule | Andrew and Formulas; Ingestion sets Interval Months/Miles/Source and Todoist Task ID, and can add rows | Read only |
| Service Types | Andrew | Read only |
| Vehicles (existing columns) | Andrew, Formulas, Ingestion (`vehicle_updates`) | Read only. `setupSchema()` replaces the two formulas in §5.3 once, when Andrew runs it. |
| Vehicles (new columns, §5.2) | Andrew by hand; Formulas for Latest Odometer and Latest Odometer Date; `setupSchema()` seeds Photo File ID once | Read only, apart from those one-time seeds |
| Warranties (existing columns + new `Type`, `Covers`) | Andrew | Read only |
| App Users, Odometer Readings, App Scans, Recalls, Push Subscriptions, Notification Log | App API (Andrew may edit App Users, and Recalls › Status) | Read and write |
| Drive `Inbox` | Family (Drive scanner) and the App API (new files only) | Creates new files; never modifies or deletes |
| Drive vehicle folders, `_Needs Review` | Cowork (renames and moves, keeping the file ID) | Reads location and metadata; streams files listed below |
| Drive `_System/Queue` | Cowork writes; Ingestion reads, then trashes | None |

The App API's write guard is in code: `apps-script/Sheet.js` refuses to append or update rows on any tab that isn't one of its six own tabs. Text it writes that starts with `=`, `+`, `-` or `@` is stored as plain text (apostrophe-escaped), never as a formula.

## Columns, by tab

Legend for "Read by":
- **I** Ingestion
- **C** Cowork (from the spec; Cowork's prompts weren't inspected)
- **F** Formulas
- **API** App API

### Vehicles

One row per vehicle. `Vehicle` is the key used on every other tab.

| Column | Written by | Read by | Notes |
| --- | --- | --- | --- |
| Vehicle | Andrew | I, F, API, C | Key. I uses it for `vehicle_updates` and to validate visits. |
| Year | Andrew | API | Year for the NHTSA recall lookup. |
| Make, Model | Andrew | API | Display, short name, photo placeholder. |
| VIN | Andrew, I | F, API | Vehicle Basics (copy), owner-entry PDF, NHTSA VIN link. |
| VIN Last 6 | F (`RIGHT(VIN,6)`) | — | |
| Plate | Andrew, I | API | Header, owner-entry PDF. |
| Primary Driver | Andrew, I | API, C | First names ("Andy"). Matched to App Users › Driver Name for notifications and nudges. |
| Active | Andrew | API | Only `Yes` rows appear in the app. |
| Drive Folder ID | Andrew | API, C | Scan status: "is the file inside a vehicle folder?" |
| Original In-Service Date | Andrew, I | API | Display. |
| Purchase Date | Andrew, I | F, API | Avg Miles/Day; costs; "Before we owned it". |
| Purchase Mileage | Andrew, I | F, API | Avg Miles/Day; cost per mile. The Highlander needs 7 entered (see SETUP.md). |
| Last Visit Date | F: `MAXIFS(Visits Date)` | C? | **Unchanged** (§5.3). The App API doesn't use it. |
| Last Known Mileage | F: `MAXIFS(Visits Mileage)` | C? | **Unchanged** (§5.3). |
| Avg Miles/Day | F; **changed by setupSchema** | F (Schedule), API, C | New: (Latest Odometer − Purchase Mileage) ÷ (Latest Odometer Date − Purchase Date). |
| Est. Current Mileage | F; **changed by setupSchema** | F (Schedule), API, C | New: Latest Odometer + Avg × (today − Latest Odometer Date). Header "~37,748 mi (estimated)". |
| Dealer Next Due Date / Miles | F: `MAXIFS` over Visits | API | Upcoming "Dealer's next service", notifications. |
| Notes | Andrew, I | — | Not shown in the app. |
| Purchase Price | Andrew, I | — | Not used by the app. |
| Photo File ID | seeded by setupSchema, Andrew | API | Header photo; the file proxy allows this ID. |
| Oil Spec … Battery Group (11 columns) | Andrew | API | Vehicle Basics; blank shows "Not set". |
| Registration Expires | Andrew | API | Upcoming (≤ 60 days), notifications at 60 and 30 days. |
| Registration File ID | Andrew | API | Registration row; the file proxy allows this ID. |
| NHTSA Make, NHTSA Model | Andrew | API | Daily recall lookup (e.g. `TOYOTA` / `4RUNNER`, `JEEP` / `WRANGLER`). |
| OEM App Name, OEM App Link, OEM App Store Link | Andrew | API | "Open \<app>" button and its App Store fallback. |
| Latest Odometer | F (new) | F, API | Highest of Visits Mileage and Odometer Readings Mileage for the vehicle. |
| Latest Odometer Date | F (new) | F, API | Date of that reading. |

### Visits

One row per shop visit. Rows are not sorted.

| Column | Written by | Read by | Notes |
| --- | --- | --- | --- |
| Visit ID | I | I (duplicate check), API | Key that joins services, documents, recommendations and readings. |
| Vehicle, Date, Mileage | I | F, I, API | Journal; Latest Odometer; odometer nudge (60 days). |
| Location | I | API | Shop name in lists and the "receipt is filed" notification. |
| RO # | I | API | Shown as "Repair order" in visit detail only. |
| Summary | I | API | One line in the list; searchable. |
| Invoice Total | I | API | Costs; "—" when blank; counted in "N visits have no total recorded". |
| Amount Paid, Card Surcharge | I | API | Visit detail. |
| Dealer Next Due Date / Miles | I | F (Vehicles) | |
| Source | I | API | Tags: CarFax, Owner (`Owner-reported`, `Owner journal`), Purchase. Costs exclude `Purchase`. |
| Receipt | I (`HYPERLINK`) | — | The app uses Documents instead. |
| Needs Review | I | — | |
| Notes | I (and `notes_append`) | API | Behind a collapsed "Details" disclosure only. |
| Added By, Added At | I | — | |

### Visit Services

| Column | Written by | Read by | Notes |
| --- | --- | --- | --- |
| Vehicle, Visit ID, Date, Mileage | I | F (Schedule), API | |
| Service Type | I | F (Schedule Last Done), API | Costs by service type; search; linking a schedule row to its last visit. |
| Description (as printed), Line Cost, Notes | I | API | Visit detail; costs by service type; search. |

### Documents

| Column | Written by | Read by | Notes |
| --- | --- | --- | --- |
| Visit ID, Vehicle | I | API | |
| Document Type, File Name, Pages | I | API | Visit detail; PDFs are listed before page images. |
| Drive File ID | I (I also *deletes* rows when it merges page images) | API | **Scan status:** a scan is "Filed" when its Drive file ID appears here. The file proxy allows these IDs. |
| Link | I (`HYPERLINK`) | — | |
| Complete | I (`set_complete`) | API | `No` shows a "Pages missing" badge. |
| Notes | I | API | Visit detail. |

### Recommendations

| Column | Written by | Read by | Notes |
| --- | --- | --- | --- |
| Rec ID | I | I, API | |
| Vehicle, Visit ID, Date, Mileage, Item, Estimate | I | API | Upcoming rows; Item is matched to a Service Type through Receipt Synonyms for coverage callouts. |
| Status | I (and `resolveRec_` sets Done) | API | `Open` means "Declined at last visit"; `Watch` means "Keep an eye on"; `Done` is hidden. |
| Resolved By Visit, Notes | I | API | Visit detail. |

### Inspection Readings

| Column | Written by | Read by | Notes |
| --- | --- | --- | --- |
| Vehicle, Visit ID, Date, Mileage | I | API | |
| Item | I | API | Wear uses items starting `Tread` or `Brake Pad`. The axle comes from "Front"/"Rear". Other items (tire pressure, battery) show in visit detail only. |
| Value, Unit, Rating | I | API | Replacement points: tread 4/32 in, brake pads 3 mm. |

### Schedule

| Column | Written by | Read by | Notes |
| --- | --- | --- | --- |
| Vehicle, Service Type | Andrew, I (new rows) | F, I, API, C | |
| Interval Months, Interval Miles, Interval Source | Andrew, I | F, API | Upcoming detail. |
| Last Done Date / Miles | F (`MAXIFS` over Visit Services) | F, API | |
| Next Due Date / Miles | F | F, API, C | |
| Est. Date for Miles | F (uses Vehicles Est. Current Mileage and Avg Miles/Day) | F, API, C | **Shifts slightly when the §5.3 formulas change.** |
| Due By, Status | F | API, C | The app shows these exactly, and never recalculates them. |
| Todoist Task ID | I (from Cowork) | C | Not used by the app. |

### Warranties

| Column | Written by | Read by | Notes |
| --- | --- | --- | --- |
| Vehicle, Warranty | Andrew | API | |
| Start Date, End Date, Start Miles | Andrew | API | |
| End Miles | Andrew (one row uses `=E2+12000`) | API | A plan ends at whichever comes first, End Date or End Miles (estimated with Avg Miles/Day). |
| Notes | Andrew | API | |
| Type (new) | Andrew | API | `Warranty`, `Prepaid plan`, `Tire warranty`. |
| Covers (new) | Andrew | API | Comma-separated Service Types, or `All`. Drives the green "Covered: \<plan>" callouts. |

### Service Types

| Column | Written by | Read by | Notes |
| --- | --- | --- | --- |
| Service Type | Andrew | C, API | Canonical names; Owner-entry service picker. |
| Receipt Synonyms (for matching) | Andrew | C, API | The API also uses these to match Recommendations Items to a Service Type. |

### Log

`Timestamp, Source, Level, Message`.
- Written by Ingestion.
- `setupSchema()` appends rows with Source `app-setup`, including every formula it replaces (the old text is saved first).
- Not read by the app.

### App Users (app-owned)

| Column | Notes |
| --- | --- |
| Email | Google account, lower-case. The allowlist: any account not here with Active = Yes gets "This app is for the Norby family" and no data. |
| Name | "Andrew". Used in greetings and scan file names. |
| Default Vehicle | A Vehicle name; the app opens on it. |
| Active | `Yes` / `No`. Checked on **every** request. |
| Notification Prefs | JSON such as `{"odometerNudge": false}`; missing keys mean on. Written by the app's Settings screen. |
| Driver Name | "Andy". Matches Vehicles › Primary Driver (added after the spec's five columns). |

### Odometer Readings (app-owned)

`Reading ID, Vehicle, Date, Mileage, Entered By, Entered At, Note`.
- Formulas read Vehicle, Date and Mileage for Latest Odometer.
- Reading ID is the phone's own ID, so an offline retry never adds the same reading twice.

### App Scans (app-owned)

`Scan ID, Kind, Vehicle Hint, Drive File ID, File Name, Pages, Uploaded By, Uploaded At, Status, Status Detail, Visit ID, Last Checked`.
- **Kind** is `Receipt`, `Upload` or `Owner entry`.
- **Status** is one of `Waiting`, `Filed`, `Adding to journal`, `Needs attention`, `Check with owner`, updated every 30 minutes from the file's Drive location.
- **Vehicle Hint** only helps tracking; Cowork still identifies the vehicle from the receipt.
- Scans made in the Google Drive app aren't listed here.

### Recalls (app-owned)

`Vehicle, Campaign Number, Report Date, Component, Summary, Consequence, Remedy, Status, First Seen, Notes, Park It, Park Outside`.
- **Rows** come from the daily NHTSA lookup.
- **Status** is `New`, `Reviewed`, `Done` or `Not applicable`. Andrew edits it by hand, and only `New` appears in Upcoming.
- **Park It / Park Outside** are NHTSA's "do not drive" and "park outside" flags. They were added after the spec's columns.

### Push Subscriptions (app-owned)

`Email, Endpoint, Keys, Device Label, Created At, Last Success, Active`.
- One row per phone that allowed notifications.
- Keys is `{"p256dh": "...", "auth": "..."}`.
- Endpoints that Apple reports as gone (HTTP 404/410) get Active = No.

### Notification Log (app-owned)

`Key, Email, Title, Sent At, Result`.
- A notification is sent at most once per Key and Email.
- Result is `Sent`, `Bundled`, `No device` or `Silent (first import)`. A failed send writes nothing and is retried.

## Drive file IDs the App API will stream

The document viewer and photo headers go through `getFile`. It only serves IDs found in these places, and refuses anything else:
- Documents › Drive File ID;
- App Scans › Drive File ID;
- Vehicles › Photo File ID;
- Vehicles › Registration File ID.

## Things that would break the app if changed

- **Renaming a header** listed above for the App API. Columns may move, since everything is read by header name, but names must stay.
- **Renaming a tab.**
- **Changing a Status vocabulary:** Schedule `OK`/`Due soon`/`Overdue`/`No history`, Recommendations `Open`/`Watch`/`Done`, Recalls `New`.
- **Moving a vehicle's Drive folder** without updating Drive Folder ID. Scan status then reads "Check with Andrew".
- **Removing the Latest Odometer formula columns.** Avg Miles/Day and Est. Current Mileage refer to them.
