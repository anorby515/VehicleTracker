# Front end guide

`web/` is Vite + TypeScript + Preact with Preact Signals for state. There is no other UI framework. The app runs as an iPhone home-screen web app from GitHub Pages at `/VehicleTracker/`.

## Layout

| Folder | Owns |
| --- | --- |
| `src/api/` | The contract (`types.ts`), the client (`client.ts`), and a mock API (`mock.ts`) backed by `src/mock/*.json` from `npm run fixture` |
| `src/state/` | Store (`store.ts`: session, bootstrap, online), hash router (`router.ts`), service worker registration |
| `src/lib/` | Pure helpers: `format.ts` (dates, miles, money, countdown), `db.ts` (IndexedDB), `pdfjs.ts` (lazy pdf.js) |
| `src/ui/` | Shared primitives: `Sheet`, `Icon`, `StatusBadge`/`CoveredBadge`/`Tag`, `toast` |
| `src/screens/` | Shell: sign-in, not-family, splash, main layout (pager, top bar, dots, FAB placement, banners), search, settings, install guide |
| `src/vehicle/` | Everything on one vehicle card, and every `#/v/<vehicle>/…` sheet |
| `src/receipts/`, `src/scanner/`, `src/pdf/`, `src/uploads/` | Add Receipt, the scanner, PDF building, the upload queue, My scans |
| `src/sw.ts` | Service worker: precache, runtime caches, push, notification click |

## Conventions

- **Dates** are `YMD` strings in America/Chicago. Format them with `lib/format.ts`; never use `new Date('YYYY-MM-DD')`. Display dates as "Dec 25, 2026" and miles as "40,000 mi".
- **Don't recalculate due dates or mileage estimates.** The Sheet's values arrive in the bootstrap. The client computes only presentation, such as countdown text.
- **Status colour always comes with a word** (`StatusBadge`). Every control has a VoiceOver label; icon-only buttons pass `label` to `Icon` or use `aria-label`.
- **Tap targets are at least 44 pt** (`.row`, `.btn`, `.icon-btn`). Use the iOS inset-grouped list classes in `styles/base.css` (`.section`, `.group`, `.row`) and the `Sheet` component for sub-views.
- **Wording is plain and friendly.** No jargon in list views, so "Repair order" rather than "RO #", and only in detail views. Visits › Notes only appears behind a collapsed "Details" disclosure.
- **Deep links** use `href.*` from `state/router.ts`. Sub-views are routes (`#/v/<vehicle>/<panel>`) so notifications can open them, and so closing uses `back(fallback)`.
- **Offline:** read from `bootstrap` (cached by the store). Writes (scans, odometer readings) go into IndexedDB queues first and are sent when online.
- **Mock mode:** `npm run dev:mock`, or leave `apiUrl` blank in `app.config.json`. Sign-in shows the fixture's people. Playwright tests run against mock mode.
- Keep components small and colocate CSS in a `*.css` file next to the component (imported by it). Use the tokens in `base.css`; don't hard-code colours.
