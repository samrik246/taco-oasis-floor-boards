# Fixtures (CSV for Cursor / API)

GitHub Contents API does not support pushing binary `.xlsx` reliably for this workflow, so the in-repo sample schedule is CSV.

| File | Maps to | Required |
|------|---------|----------|
| `fixtures/schedules-restaurant.csv` | Sheet `Schedules - Restaurant` | Yes (ingest source) |
| `fixtures/hourly-restaurant.csv` | Sheet `Hourly - Restaurant` | No (ignore in v1) |
| `fixtures/wheniwork-restaurant-export-sample.xlsx` | Full workbook | Optional (local git push) |

**Load sample** should import `schedules-restaurant.csv` (ignore hourly in v1), or the xlsx if present. Column contract is documented in `docs/SPEC.md` §3.
