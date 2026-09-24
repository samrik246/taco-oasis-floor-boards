# Fixtures

## Preferred for tests (in repo)
- `schedules-restaurant.csv` — export of sheet `Schedules - Restaurant` (REQUIRED ingest source)
- `hourly-restaurant.csv` — export of sheet `Hourly - Restaurant` (optional; ignore in v1)

## Optional binary
- `wheniwork-restaurant-export-sample.xlsx` — original When I Work workbook (same data). Add via local `git push` if needed; parser should accept **either** `.xlsx` **or** the CSV pair.

## Load sample button
Should import `schedules-restaurant.csv` (and ignore hourly in v1), or the xlsx if present.

## Synthetic people (C1, 2026-09-23)
Every name, Employee ID, pay value and note in these fixtures is invented; email cells are empty.
IDs include `0042` and `42` as two different people. Rebuild the xlsx with `pnpm fixture:xlsx`
after editing either CSV; it reads Employee ID as text, like the upload path.
