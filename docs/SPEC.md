# Taco Oasis Floor Boards — Product & Engineering Spec (Beta)

**Owner:** Sam / Taco Oasis  
**Status:** Spec for Cursor beta build  
**Related ops today:** Google Sheet `caja nuevos colores` color boards → PDF (`J:AD`) → Jolt Cashiers lists. This app is the long-term floor UI; Sheets/Jolt remain backup until trusted.

---

## 1. Problem

Today cashiers (and kitchen) station plans live in spreadsheet color boards:
- Manual copy from schedule exports
- Easy to assign people outside their shift
- Easy to double-book Green 1 / other primaries
- No durable **hours-by-person-by-station** history
- Floor consumes a static PDF in Jolt — not live, not editable

We need a **web app on iPad/monitor** that:
1. Ingests the schedule export we already use
2. Splits **Caja** vs **Cocina**
3. Lets managers place people on stations in real time (within shifts)
4. Tracks abilities + hours (algorithm auto-fill comes later)
5. Can later publish snapshots / feed Jolt

---

## 2. Product vision (beta scope vs later)

### Beta (build now)
- Upload `.xlsx` Restaurant export (When I Work style)
- Parse shifts; split Caja / Cocina
- Day picker for dates present in file
- Live-ish board UI: stations × now/hour scrubber
- Manual assign / swap / clear with rule engine
- Employee ability tags (editable stubs)
- Hours ledger from assignments
- Sample fixture + Load sample
- Two board modes: Cashiers | Kitchen (same app)

### Explicitly later (stub only)
- Auto-fill algorithm (priority ladder + variety + new-hire locks)
- Realtime multi-device sync (Supabase/Firebase)
- Timeclock “actually clocked in”
- Jolt PDF publish pipeline
- Auth / PIN / roles beyond single-manager local
- When I Work API (file upload is enough for beta)

---

## 3. Schedule export contract (source of truth for beta)

Sample: `fixtures/wheniwork-restaurant-export-sample.xlsx`

### Sheet: `Schedules - Restaurant` (REQUIRED)
| Column | Use |
|--------|-----|
| Schedule | ignore (Restaurant) |
| Site | optional |
| **Position** | role routing + default station hints |
| OpenShift Count | ignore |
| **First Name**, **Last Name** | display |
| **Employee ID** | stable identity (prefer over name) |
| Email | optional |
| **Shift Start Date** | `YYYY-MM-DD` |
| **Shift Start Time** | e.g. `8:00 am` |
| **Shift End Time** | e.g. `5:00 pm` |
| Unpaid Break | optional |
| Scheduled Hours | optional check |
| Hourly Rate / Labor Cost | **do not store in UI** (PII/pay); strip on import |
| Status / Notes | optional |

### Sheet: `Hourly - Restaurant` (OPTIONAL for beta)
Hours matrix by day — can ignore in v1 parser; do not fail import if present.

### Observed Position values (route by string rules)
**Caja board** if Position matches (case-insensitive) any of:
- starts with `Caja` OR contains `Caja`
- Examples: `Caja - Regular`, `Caja Manager`, `Caja - Nieves`, `Caja - Meser@`, `Caja - Limpieza`, `Caja - Prueba`

**Cocina board** if Position matches:
- `Cocina`, `Cocina - Abrir`, `Cocina Guia Abrir`, `Cocina Guia Cerrar`, `Produccion`, `Picar Carne`
- Default: contains `Cocina` OR equals `Produccion` OR equals `Picar Carne`

**Neither board (import but hide from floor boards by default):**
- `GM`, `UP Manager`, `Catering Manager`, `Catering DRIVER`, etc.

**Defaults:** If a position is ambiguous, put on **neither** floor board but keep in DB as `board=other` for later mapping UI.

---

## 4. Domain rules (encode as pure functions + tests)

### 4.1 Shift window (hard)
For each assignment cell `(employee, date, hourStart)`:
- Allowed iff `shiftStart <= hourStart < shiftEnd` (match existing Sheets convention: inclusive start, exclusive end).
- Parse times in venue local timezone **America/Chicago**.
- Hour grid default: **7:00–22:00** in 1-hour buckets (configurable constant).

### 4.2 Station uniqueness (hard)
At a given `(board, date, hour, stationId)`:
- At most **one** employee — **except** station `nieves` which may have many.

### 4.3 Position-type hints from schedule Position string
| Schedule Position | Default ability / behavior |
|-------------------|----------------------------|
| Caja Manager | can work `mana`; prefer mana |
| Caja - Regular | regular cashier stations |
| Caja - Nieves | can stack on `nieves` |
| Caja - Meser@ | mesero role |
| Caja - Limpieza | cleaning; limited stations |
| Caja - Prueba | treat as **new hire / training** (Green lock preference) |
| Cocina* | kitchen stations only |

### 4.4 Caja stations (beta dictionary)
| id | label | color | maxConcurrent | priority |
|----|-------|-------|---------------|----------|
| mana | MANA (Manager) | pink | 1 | — |
| green1 | Green 1 | green | 1 | 1 |
| yellow | Yellow / Outside | yellow | 1 | 2 |
| purple1 | Purple 1 | purple | 1 | 3 |
| green2 | Green 2 / Jolt | lime | 1 | 4 |
| blue | Blue / Outside | blue | 1 | 5 |
| purple2 | Purple 2 | lavender | 1 | 6 |
| multi | MULTI | gray | 1 | 7 |
| nieves | Nieves | teal | unlimited | — |
| mesero | Mesero | orange | 1 | — |
| clean | Limpieza / Clean | cyan | 1 | — |

### 4.5 Cocina stations (beta placeholder dictionary)
Implement editable config; seed:
`guia_abrir`, `linea`, `expo`, `prep`, `cerrar`, `produccion`, `picar`, `dish` — each maxConcurrent=1 except optionally `linea` allow 2 in config.

### 4.6 Auto-fill algorithm (STUB ONLY in beta)
```ts
interface AutoFillEngine {
  suggest(input: DayContext): AssignmentSuggestion[];
}
class NoOpAutoFill implements AutoFillEngine {
  suggest() { return []; }
}
```
Wire a button “Auto-fill (coming soon)” disabled or no-op with toast.  
**Do not** invent fill logic in beta beyond the stub.

Future algorithm inputs (document for later): priority ladder, variety, new-hire green week, abilities matrix, hours ledger fairness.

### 4.7 Abilities matrix (beta)
Table `EmployeeStationAbility`:
- employeeId, stationId, level: `forbidden | training | ok | preferred`
- Seed from Position hints; managers can edit in UI
- Assign UI filters/sorts by ability; **block** `forbidden`

---

## 5. UX (iPad / monitor)

### Layout
- Landscape primary
- Header: Board toggle (Cashiers | Kitchen) · Date · Clock · “Load sample” · Upload
- Left: people available for selected hour (in shift, not assigned)
- Center: station tiles for **selected hour** (big touch targets) OR full day grid (toggle)
- Right / drawer: hours this week by station for selected person
- Violations banner (red) listing rule breaks if any slipped in

### Interactions
- Tap station → pick person from available list
- Drag person → station (if feasible with HTML5/Pointer; fallback tap-tap)
- Swap: select two assignments
- Clear assignment
- Mark break (removes from station but still “on shift”)

### Crew vs manager (beta)
Single mode with edit enabled. Add `?readonly=1` query for display-only.

---

## 6. Data model (SQLite)

```
Employee(id PK, externalId, firstName, lastName, email?)
Station(id PK, board enum caja|cocina, label, color, maxConcurrent, sortOrder)
Shift(id, employeeId, date, startAt, endAt, sourcePosition, board)
Assignment(id, shiftId, stationId, hourStart, hourEnd) // usually 1h
EmployeeStationAbility(employeeId, stationId, level)
ImportBatch(id, filename, importedAt, rowCount)
HoursLedgerAgg — materialized view or query: sum(assignment duration) group by employee, station, week
```

**Privacy:** Do not persist Hourly Rate / Labor Cost from xlsx.

---

## 7. API / app routes (suggested)
- `POST /api/imports` — multipart xlsx
- `GET /api/days` — dates available
- `GET /api/boards/:board/days/:date` — shifts + assignments + stations
- `PUT /api/assignments` — create/update with server-side rule validation
- `DELETE /api/assignments/:id`
- `GET /api/employees/:id/hours` — ledger
- `PUT /api/abilities/:employeeId`
- `GET /api/sample` — triggers fixture import

All writes validate domain rules; return 422 with machine-readable violation codes.

---

## 8. Tech recommendations (Defaults)

| Concern | Choice |
|---------|--------|
| Framework | Next.js 15 App Router + TypeScript |
| UI | Tailwind + shadcn/ui |
| DB | SQLite + Prisma |
| XLSX | ExcelJS |
| Validation | Zod |
| Domain tests | Vitest |
| E2E | Playwright |
| Package manager | pnpm |
| Deploy later | Vercel (SQLite→Turso/Postgres later) |

 monorepo optional; single Next app is fine for beta.

---

## 9. Build slices (each must end green)

1. **Scaffold** — Next+Tailwind+Prisma+SQLite; `pnpm build`  
2. **Seed stations** — caja + cocina dictionaries  
3. **XLSX parser** — Schedules sheet → normalized Shift DTOs; unit tests on sample file (counts: caja vs cocina rows)  
4. **Import API + DB** — persist employees/shifts; strip pay columns  
5. **Day board read API** — by board+date  
6. **UI shell** — board toggle, date select, load sample  
7. **Station tiles + available people** for selected hour  
8. **Assign + uniqueness + shift-window enforcement** (API+UI); tests for double green1 reject; nieves multi allow  
9. **Swap + clear**  
10. **Abilities seed + filter**  
11. **Hours ledger query + person panel**  
12. **Violations banner**  
13. **Readonly mode** `?readonly=1`  
14. **Playwright smoke** — load sample → open Caja Sep 20 → assign → see ledger bump  
15. **Polish** — big touch CSS, empty states, error toasts  

Agent: complete as many slices as possible; never leave failing tests.

---

## 10. Parser acceptance tests (from sample fixture)

Using `fixtures/wheniwork-restaurant-export-sample.xlsx`:
- `Schedules - Restaurant` has shifts spanning **2026-09-18 … 2026-09-24**
- Position bucket counts roughly: Caja ~109, Cocina ~105, Other ~19 (assert ±5 or exact from re-parse)
- Employee ID `8304` appears as both `Caja - Regular` and `Caja - Nieves` on different rows — both must import as separate shifts
- `Caja - Meser@` normalizes station hint `mesero` (keep raw position string)

---

## 11. Out of scope / non-goals (beta)
- Mobile-native apps  
- Payroll  
- Full When I Work OAuth  
- Replacing Google Sheets color board formulas this week  
- Asking the user clarifying questions during build  

---

## 12. Success criteria for “beta usable on one iPad”
1. Manager uploads weekly export (or Load sample)  
2. Sees Cashiers board for today/selected day with correct people in-shift  
3. Can fill stations without violating shift/uniqueness rules  
4. Can switch to Kitchen board with cocina people  
5. Can open a person and see hours by station accumulated this week  
6. Survives refresh (SQLite persistence)

---

## 13. Future integration notes (do not build yet)
- Publish PDF crop analogous to Sheets `J:AD` for Jolt King handoff  
- Realtime sync across devices  
- AutoFillEngine using priority Green1→Yellow→Purple1→Green2→Blue→Purple2→MULTI + variety + new-hire green week  
- Live “where we are in the day” service phases  

---

## 14. Defaults cheat-sheet (when tempted to ask)
- Timezone: America/Chicago  
- Hour grid: 7–22  
- DB: SQLite file `prisma/dev.db`  
- Port: 3000  
- Board labels: “Cashiers” / “Kitchen”  
- Nieves stacking: allowed  
- Pay columns: dropped  
- Auto-fill: stub only  
