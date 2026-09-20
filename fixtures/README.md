# Fixtures

## wheniwork-restaurant-export-sample.xlsx

This directory should contain a sample When I Work Restaurant export used by parser tests and the app **Load sample** button.

**Expected filename:** `wheniwork-restaurant-export-sample.xlsx`

If the binary `.xlsx` is missing from this repo (GitHub MCP/API binary upload limitations from this agent), add it locally:

1. Place the real When I Work Restaurant export at:
   `fixtures/wheniwork-restaurant-export-sample.xlsx`
2. It must include sheets:
   - `Schedules - Restaurant` (required)
   - `Hourly - Restaurant` (optional)
3. Sample week dates used in SPEC: **2026-09-18 … 2026-09-24**

A base64-encoded copy may also be present as
`fixtures/wheniwork-restaurant-export-sample.xlsx.b64`.
Decode with:

```bash
base64 -d fixtures/wheniwork-restaurant-export-sample.xlsx.b64 > fixtures/wheniwork-restaurant-export-sample.xlsx
```

Do not commit pay-sensitive columns into other fixtures; the app strips `Hourly Rate` / `Labor Cost` on import.
