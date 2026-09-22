# Taco Oasis Floor Boards (Beta Spec)

Live **Cashiers** + **Kitchen** station boards for Android tablet / iPad / monitor (Chrome landscape).

**Repo:** https://github.com/samrik246/taco-oasis-floor-boards

Upload a When I Work–style Restaurant schedule `.xlsx`, split **Caja** vs **Cocina**, assign people to stations inside their shift windows, track hours by position. Auto-fill algorithm comes later (stub only in beta). Optimized for **Android tablet Chrome** (touch ≥44px, no hover-only). Manager day notes, hours ledger, violations banner, and `?readonly=1` are in Stage 3.

## For Cursor
1. Clone this repo
2. Paste the entire contents of [`prompts/PASTE_INTO_CURSOR.md`](prompts/PASTE_INTO_CURSOR.md) into Cursor Agent / Cloud Agent
3. That prompt says: **do not ask questions — build and test in slices**
4. Always treat [`docs/SPEC.md`](docs/SPEC.md) as the source of truth

## Docs
- [`docs/SPEC.md`](docs/SPEC.md) — full product, data model, rules, MVP, test slices
- [`docs/DECISIONS.md`](docs/DECISIONS.md) — defaults chosen during build
- [`prompts/CURSOR_BUILD_BETA.md`](prompts/CURSOR_BUILD_BETA.md) — short build brief
- [`prompts/PASTE_INTO_CURSOR.md`](prompts/PASTE_INTO_CURSOR.md) — **long copy-paste prompt**

## Sample fixture
- `fixtures/schedules-restaurant.csv` — preferred ingest source (CI-friendly)
- `fixtures/hourly-restaurant.csv` — optional; ignored in v1
- `fixtures/wheniwork-restaurant-export-sample.xlsx` — Excel workbook (regenerate via `pnpm tsx scripts/build-sample-xlsx.ts`)

Sheets: `Schedules - Restaurant` (required), `Hourly - Restaurant` (optional)

## Quick start
```bash
pnpm i
# Local demo only: never use this flag on the home base.
DEMO_MANAGER_CODES=1 pnpm db:setup
MANAGER_SESSION_SECRET="replace-with-a-local-secret-of-32+-characters" pnpm dev
# http://localhost:3000
```

## Scripts
| Command | Purpose |
|---------|---------|
| `pnpm dev` | Next.js dev server (port 3000) |
| `pnpm build` | Prisma generate + Next production build |
| `pnpm test` | Vitest unit/integration tests |
| `pnpm test:e2e` | Playwright smoke (fresh `prisma/e2e.db`) |
| `pnpm db:setup` | `prisma db push` + seed stations and an initial manager |
| `pnpm tsx scripts/build-sample-xlsx.ts` | Rebuild sample xlsx from CSV |

## Manager access

Staff view is the default tablet UI. **Manager unlock** uses personal codes (hashed in DB). Every running app also needs a private `MANAGER_SESSION_SECRET` of at least 32 characters; it is never sent to the browser.

For an empty production database, set `INITIAL_MANAGER_NAME` and a four-or-more-character `INITIAL_MANAGER_CODE` only for `pnpm db:setup`; it creates one hashed manager code. Remove the bootstrap code from the environment afterward. The Back office **Managers** tab can add managers, rotate codes, and deactivate old access without showing stored codes or hashes.

`DEMO_MANAGER_CODES=1` creates the documented demo accounts for local development and Playwright only. It must never be set on a home-base deployment.

Idle timeout: **15s** back to staff (`MANAGER_IDLE_MS`, default `15000`).

Board language: **Cashiers (caja) = English**, **Kitchen (cocina) = Spanish**. View toggle: **Board | Timeline | Tareas**.

## Stage 1 APIs
- `POST /api/imports` — multipart field `file` (xlsx or schedules csv)
- `GET /api/days` — dates present after import
- `GET /api/boards/:board/days/:date` — stations + shifts (+ assignments + abilities) for `caja` or `cocina`

## Stage 2 APIs
- `GET /api/sample` — import the in-repo sample xlsx in one click
- `PUT /api/assignments` — `{ shiftId, stationId, date, hour }` with server-side rules (422 + violation codes)
- `DELETE /api/assignments/:id` — clear
- `POST /api/assignments/swap` — `{ assignmentIdA, assignmentIdB }`

## Stage 3 APIs
- `GET /api/employees/:id/hours?weekOf=YYYY-MM-DD` — hours ledger (person × station minutes, Sunday–Saturday Chicago week)
- `GET /api/notes?board=caja|cocina&date=YYYY-MM-DD` — list day notes
- `POST /api/notes` — `{ board, date, body }` (author `Manager`)
- `PUT /api/notes/:id` — `{ body }`
- `DELETE /api/notes/:id`

## Stage 3 UI
- Hours this week panel (select a person)
- Violations banner (slipped-in rule breaks)
- Manager notes in `#manager-notes-slot`
- `?readonly=1` — browse board; mutations blocked (including notes)
