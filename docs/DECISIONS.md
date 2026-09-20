# Defaults chosen during Stage 1 (SPEC §14 / §8)

## Stack
- **Framework:** Next.js 16 (App Router) + TypeScript — `create-next-app` current stable (SPEC said 15; 16 is the toolchain default).
- **UI:** Tailwind CSS v4 + minimal shadcn/ui (`Button` + `cn` + `components.json`).
- **DB:** SQLite via Prisma 5.22 at `prisma/dev.db` (`DATABASE_URL=file:./dev.db`).
- **Enums:** SQLite/Prisma has no native enums — `board` and ability `level` are strings constrained in app code.
- **XLSX:** ExcelJS 4.x. Parser also accepts Schedules CSV (docs/FIXTURES.md).
- **Validation:** Zod 4.x.
- **Tests:** Vitest (node env).
- **Package manager:** pnpm.

## Venue / domain
- **Timezone:** America/Chicago.
- **Hour grid:** 7:00–22:00 (constants `HOUR_GRID_START` / `HOUR_GRID_END`).
- **Auto-fill:** `NoOpAutoFill` stub only.
- **Nieves:** `maxConcurrent = -1` (unlimited).
- **Cocina `linea`:** `maxConcurrent = 2` (SPEC §4.5 optional allowance).
- **Pay columns:** `Hourly Rate`, `Labor Cost`, `Total` detected on import headers and never persisted on shift DTOs / DB.

## Position → board routing (SPEC §3 vs §10)
SPEC §3 lists `Produccion` and `Picar Carne` under Cocina examples, but SPEC §10 acceptance counts are ≈ **109 / 105 / 19**.
With “contains Cocina OR equals Produccion OR equals Picar Carne”, cocina≈116 and other≈8 (outside ±5).

**Decision for beta:** Cocina board = Position **contains** `Cocina` (case-insensitive). `Produccion` and `Picar Carne` import as `board=other` (hide from floor boards by default; keep for later mapping UI). Cocina station seeds still include `produccion` and `picar`.

## Sample xlsx fixture
GitHub Contents API cannot push the binary reliably. In-repo CSV pair is source; `scripts/build-sample-xlsx.ts` regenerates `fixtures/wheniwork-restaurant-export-sample.xlsx` for ExcelJS tests. Generated xlsx is committed when present.

---

# Stage 2 defaults (interactive board)

## Assign / uniqueness
- **Shift window:** `shiftStart <= hourStart < shiftEnd` (America/Chicago).
- **Station uniqueness:** enforce `maxConcurrent` (`nieves` = `-1` unlimited; `linea` = `2`).
- **Person uniqueness:** one assignment per employee per hour (cannot stand at two stations). Violation code `PERSON_ALREADY_ASSIGNED`.
- **Swap:** exchanges `shiftId` on two assignment rows; re-validates shift window + ability + occupancy.
- **Clear:** `DELETE /api/assignments/:id`.

## Abilities seed (from schedule Position)
On import, each employee gets `EmployeeStationAbility` rows:
- Cross-board stations → `forbidden`.
- Same-board stations → `ok`, then overlays:
  - `Caja Manager` → `mana` preferred
  - `Caja - Nieves` → `nieves` preferred
  - `Caja - Meser@` → `mesero` preferred
  - `Caja - Limpieza` → `clean` preferred; primary cashier lanes forbidden
  - `Caja - Prueba` → `green1` / `green2` training
  - Cocina guia abrir/cerrar → preferred on matching stations
- Assign UI filters by level; **server blocks** `forbidden` (`FORBIDDEN_ABILITY`).
- Missing ability row treats as allow (`ok`) for beta.

## Load sample
- `GET /api/sample` imports `fixtures/wheniwork-restaurant-export-sample.xlsx` in one click.

## UI
- Board labels: Cashiers | Kitchen; hour scrubber 7:00–22:00; touch targets ≥44px; high-contrast station colors.
- Auto-fill button disabled / NoOp stub only.

## Android tablet (Stage 2 UX)
- Primary target: Android Chrome tablet, landscape ~1280×800+.
- Viewport via Next `export const viewport` (`device-width`, initialScale 1, viewportFit cover).
- `public/manifest.webmanifest` for Add-to-Home-Screen (standalone, landscape).
- All floor actions are tap/click; `active:` press feedback; no hover-only controls.
- CSS `--touch-min: 44px` + `.touch-target`; `touch-action: manipulation`.

## Manager notes (Stage 3 — not in Stage 2)
- Notes scoped to **board + date**; author `Manager` + Chicago timestamp (see project context).
- Stage 2 leaves `#manager-notes-slot` on the day board shell (`data-board` / `data-date`) for Stage 3 CRUD under `/api/notes`.
- No notes schema/API in Stage 2.

---

# Stage 3 defaults (ledger, violations, readonly, notes, e2e)

## Hours ledger
- **Week:** Sunday–Saturday in America/Chicago containing the selected board date (US restaurant convention).
- **Aggregation:** sum assignment `(hourEnd - hourStart)` minutes grouped by employee × station for that week.
- **API:** `GET /api/employees/:id/hours?weekOf=YYYY-MM-DD`.
- **UI:** right column “Hours this week” panel; selecting a person (available list or station assignee) loads their ledger. No pay columns.

## Violations banner
- Client scans current day-board assignments with the same pure `validateAssignment` rules used on write.
- Red alert banner lists machine-readable codes (`OUT_OF_SHIFT`, `STATION_FULL`, etc.) when any slipped in.

## Readonly mode
- Query `?readonly=1` (also accepts `true`).
- Board remains browsable (board toggle, date, hour, ledger, notes list).
- UI blocks Load sample, Upload, assign, swap, clear, and note add/edit/delete.
- Auto-fill remains the NoOp stub (disabled button).

## Manager notes
- Model `ManagerNote`: many notes per `(board, date)`; free-text body; author always `Manager`.
- Timestamps stored UTC; display label formatted America/Chicago (`Manager · Sep 20, 2026, 10:15 AM CT`).
- API: `GET/POST /api/notes`, `PUT/DELETE /api/notes/:id`.
- UI fills `#manager-notes-slot` via `ManagerNotesPanel`.
- Mutations blocked when `?readonly=1`.

## Playwright smoke
- `pnpm test:e2e` uses a **fresh disposable** SQLite file (`prisma/e2e.db`) via `DATABASE_URL=file:./e2e.db`.
- Flow: Load sample → Cashiers → date with shifts → assign → ledger minutes bump.
- Chromium only for beta CI.
