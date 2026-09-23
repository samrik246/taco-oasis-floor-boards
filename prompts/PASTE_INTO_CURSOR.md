# PASTE THIS ENTIRE PROMPT INTO CURSOR (Agent / Cloud Agent)

You are building the **Taco Oasis Floor Boards** beta from an existing GitHub repo that already contains the product spec and a real schedule fixture.

## Repository (SOURCE OF TRUTH — READ FIRST)
**https://github.com/samrik246/taco-oasis-floor-boards**

Before writing any app code, you MUST:
1. Clone or open this repo (it should already be the workspace).
2. Read end-to-end:
   - `docs/SPEC.md`
   - `README.md`
   - `prompts/CURSOR_BUILD_BETA.md`
   - Inspect `fixtures/wheniwork-restaurant-export-sample.xlsx` (Sheets: `Schedules - Restaurant`, `Hourly - Restaurant`)
3. Implement against SPEC.md. Do not invent a competing product.

---

## Operating rules (NON-NEGOTIABLE)
1. **Do NOT ask the user questions.** Never block on clarifications. Pick Defaults from SPEC.md §14 / §8 and log choices in `docs/DECISIONS.md`.
2. **Build as much of the MVP as possible** in one continuous effort.
3. **Test in many slices.** After each slice in SPEC.md §9, run tests and fix until green before the next slice.
4. Prefer many small green vertical slices over one untested monolith.
5. Use the sample xlsx for all parser/import tests. Add a **Load sample** button that imports `fixtures/wheniwork-restaurant-export-sample.xlsx` with one click.
6. Strip / never persist pay columns (`Hourly Rate`, `Labor Cost`, `Total`).
7. Auto-fill algorithm is a **stub only** (`NoOpAutoFill`). Manual assign must work fully. Do not invent auto-placement logic in this beta.
8. Timezone: `America/Chicago`. Hour grid default: 7:00–22:00.
9. When finished: `pnpm test`, `pnpm build`, and Playwright smoke must pass (or document exact remaining failures in DECISIONS.md only if truly blocked by environment — still ship runnable app).

---

## What to build (product)
A touch-friendly web app (iPad landscape) for Taco Oasis:

### Ingest
- Upload When I Work–style Restaurant `.xlsx`
- Parse **`Schedules - Restaurant`** columns:
  Position, First Name, Last Name, Employee ID, Email, Shift Start Date, Shift Start Time, Shift End Time, (+ optional unpaid break / scheduled hours / status / notes)
- Ignore or optionally skip **`Hourly - Restaurant`** in v1 (must not break import)

### Split boards by Position string
- **Cashiers (Caja):** Position contains `Caja` (e.g. `Caja - Regular`, `Caja Manager`, `Caja - Nieves`, `Caja - Meser@`, `Caja - Limpieza`, `Caja - Prueba`)
- **Kitchen (Cocina):** `Cocina*`, `Produccion`, `Picar Carne`
- **Other:** GM / catering / etc. → store as `board=other`, hide from floor boards by default

### Floor UI
- Toggle Cashiers | Kitchen
- Date picker for dates present in import (sample spans 2026-09-18 … 2026-09-24)
- Selected-hour station tiles + list of people in-shift and unassigned
- Assign / swap / clear
- Optional full-day grid toggle
- `?readonly=1` display mode
- Big touch targets, high contrast

### Hard rules (encode as pure functions + unit tests)
1. **Shift window:** assignment hour allowed iff `start <= hour < end` (inclusive start, exclusive end).
2. **Uniqueness:** at most one person per station per hour — **exception: `nieves` may stack**.
3. **Abilities:** seed from schedule Position; levels `forbidden | training | ok | preferred`; block forbidden assigns.
4. **Caja stations** (seed exactly as SPEC §4.4): mana, green1, yellow, purple1, green2, blue, purple2, multi, nieves, mesero, clean.
5. **Cocina stations** (seed SPEC §4.5 placeholders).

### Hours ledger
Every assignment contributes minutes to person × station (queryable “this week” panel on employee).

### Explicit non-goals for this beta
- Realtime multiplayer, OAuth When I Work, Jolt publish, payroll, native apps, asking the user questions.

---

## Tech stack (Defaults — just use these)
- Next.js App Router + TypeScript + Tailwind + shadcn/ui
- SQLite + Prisma
- ExcelJS for xlsx
- Zod validation
- Vitest (domain + API)
- Playwright (e2e smoke)
- pnpm

Scaffold the app **in this same repo** (do not create a second repo). Keep `docs/`, `fixtures/`, `prompts/` intact.

---

## Required build slices (SPEC §9) — each ends GREEN
1. Scaffold Next+Tailwind+Prisma+SQLite; `pnpm build`
2. Seed caja + cocina stations
3. XLSX parser unit tests on sample fixture (assert caja/cocina/other bucket counts ≈ 109 / 105 / 19 ±5; dates Sep 18–24 2026; employee 0042 (synthetic) can have multiple position rows)
4. Import API + DB persist (strip pay cols)
5. Day board read API by board+date
6. UI shell: board toggle, date, Load sample, Upload
7. Station tiles + available people for selected hour
8. Assign with server-side enforcement (reject double green1; allow multi nieves; reject out-of-shift) + tests
9. Swap + clear
10. Abilities seed + UI filter
11. Hours ledger panel
12. Violations banner
13. Readonly mode
14. Playwright: Load sample → Cashiers → date with shifts → assign → ledger updates
15. Polish empty/error states + touch CSS

Work slice-by-slice. Do not skip tests.

---

## Acceptance checklist (Done when)
- [ ] `pnpm i && pnpm dev` runs
- [ ] Load sample populates Cashiers + Kitchen for week of Sep 18–24 2026
- [ ] Cannot assign outside shift window
- [ ] Cannot put two people on green1 same hour
- [ ] Can put two people on nieves same hour
- [ ] Hours by station update after assigns
- [ ] `pnpm test` green
- [ ] `pnpm build` green
- [ ] Playwright smoke green
- [ ] `docs/DECISIONS.md` lists any defaults you chose

---

## Reference: why this exists
Ops currently use Google Sheet color boards + PDF → Jolt. This app is the future live floor board. The SPEC encodes battle-tested rules (shift windows, one-per-station except Nieves, Caja priority ladder for a *future* AutoFillEngine). Beta = ingest + manual assign + ledger + abilities. Auto-fill comes later.

**Begin now. Read SPEC.md, then execute slices 1→15 without asking questions.**
