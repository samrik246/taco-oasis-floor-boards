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
