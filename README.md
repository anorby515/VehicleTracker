# Vehicles

A home-screen web app for the Norby family's cars. It shows what's due on each vehicle, the service history, and scans receipts into the existing filing pipeline. The Google Sheet journal and Google Drive stay the single source of truth; the app is a read-mostly front end plus a doorway into that pipeline.

```text
iPhone app (GitHub Pages) ──POST──▶ App API (standalone Apps Script, runs as Andrew)
                                        ├─ reads the journal Sheet; writes only its own tabs
                                        ├─ saves scans as NEW files in Drive › Inbox
                                        └─▶ Push Worker (Cloudflare) ──▶ Web Push to iPhones

Drive › Inbox ──▶ Cowork scheduled task (unchanged) ──▶ queue JSON ──▶ ingestion script (unchanged) ──▶ Sheet
```

A scan from the app lands in `Inbox` exactly like a scan from the Google Drive app, so Cowork and the ingestion script see nothing new.

## What's in the repo

| Folder | What it is | How it's deployed |
| --- | --- | --- |
| `web/` | The iPhone app: Vite, TypeScript and Preact. It includes the receipt scanner (OpenCV.js), PDF building, offline cache and upload queue, and the push subscription. | GitHub Actions to GitHub Pages on every push to `main` |
| `apps-script/` | The App API, a **new standalone** Apps Script project. It handles sign-in checks, the bootstrap data, the file proxy, chunked uploads to `Inbox`, odometer readings, `setupSchema()`, and the scan-status, recall and notification jobs. | Andrew pastes the files into it (or uses `clasp push`), then deploys it as a web app |
| `push-worker/` | A Cloudflare Worker that signs VAPID JWTs and encrypts Web Push messages. Apps Script can't do ES256. | Cloudflare dashboard or `wrangler deploy` |
| `docs/` | `DATA_CONTRACT.md` (who writes what, column by column), `DECISIONS.md` (choices the spec left open), `API.md` (the API contract), `FRONTEND.md` (front-end conventions) | — |
| `SETUP.md` | Andrew's step-by-step setup and the acceptance checklist | — |

## Guardrails this build keeps

- It doesn't change the ingestion script (`processQueue`, `installTrigger`, `onOpen`, helpers) or its 15-minute trigger, and it doesn't change the Cowork prompts.
- The API never writes to the journal tabs: Visits, Visit Services, Documents, Recommendations, Inspection Readings, Schedule, Service Types. `apps-script/Sheet.js` refuses row writes outside the six app-owned tabs.
- New columns only ever go at the end of a tab. Every tab is read by header name.
- The only formulas that change are Avg Miles/Day and Est. Current Mileage (spec §5.3). They change only through `setupSchema()`, which is a dry run by default, idempotent, saves the old formula text to the Log first, and skips anything that doesn't match exactly what it expects.

## Live Sheet vs. spec

The spec's schema was captured on 2026-09-22. The live Sheet was checked on 2026-09-22 (by reading it through Drive):
- **Headers:** all ten tabs match the spec exactly.
- **Formulas:** per-row formulas with no `ARRAYFORMULA`. Last Known Mileage and Dealer Next Due Date/Miles use `MAXIFS`, so they take the *highest* value rather than the latest visit's. Latest Odometer follows the same convention (see DECISIONS.md).
- **Ingestion script:** it writes Vehicles cells by header name through `vehicle_updates`, and appends missing columns at the end with `ensureColumn_`. So the new Vehicles columns and formulas don't conflict with it. It also deletes Documents rows when it merges page images into one PDF. The file proxy and scan status read Documents fresh on every check, so that's handled.
- **Highlander Purchase Mileage:** blank in the Sheet. It should be 7 (the delivery miles, per Andrew), otherwise the Highlander gets no Avg Miles/Day. SETUP.md says to fill it in.
- **Warranties:** the tab has only the two 4Runner rows. Andrew adds the Telluride, BMW prepaid and Costco tire rows (SETUP.md §9).

## Developing

Requires Node 22.

```sh
npm install                 # installs web/ and push-worker/ (npm workspaces)
npm test                    # App API logic (Node, no live Sheet), Push Worker, front-end unit tests
npm run fixture             # rebuilds web/src/mock/*.json from the synthetic Sheet fixture
npm run dev:mock -w web     # the app against the mock API at http://localhost:5173/VehicleTracker/
npm run test:e2e -w web     # Playwright (iPhone-sized Chromium, mock API)
npm run build               # type-check and production build to web/dist
```

The test data is **synthetic**: made-up people, VINs, IDs and amounts, shaped like the real journal. No family data is committed. See DECISIONS.md › Hosting and privacy.

## Setting it up

Follow [SETUP.md](SETUP.md) from the top. It covers moving the finished code to a clean public repo (the spec was in this repo's history), Google Cloud, Cloudflare, the App API project and `setupSchema()`, filling in the Sheet, installing on the phones, and the acceptance checklist.
