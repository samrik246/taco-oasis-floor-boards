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
