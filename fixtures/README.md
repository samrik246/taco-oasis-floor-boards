# Fixtures

## wheniwork-restaurant-export-sample.xlsx

**Status:** The binary `.xlsx` could not be committed via GitHub MCP `create_or_update_file` / `push_files` (those tools treat `content` as UTF-8 text; a base64 probe produced a corrupt 72-byte file and was removed).

### Add the sample locally / via git CLI

The real sample lives on the agent box at:

`/workspace/taco-oasis-floor-boards/fixtures/wheniwork-restaurant-export-sample.xlsx`

(36,734 bytes; sheets `Schedules - Restaurant` + `Hourly - Restaurant`; week **2026-09-18 … 2026-09-24**).

From a machine with `gh` auth or a GitHub token:

```bash
git clone https://github.com/samrik246/taco-oasis-floor-boards.git
cp /path/to/wheniwork-restaurant-export-sample.xlsx fixtures/
git add fixtures/wheniwork-restaurant-export-sample.xlsx
git commit -m "Add When I Work sample xlsx fixture"
git push origin main
```

Or decode if you have a base64 companion:

```bash
base64 -d fixtures/wheniwork-restaurant-export-sample.xlsx.b64 > fixtures/wheniwork-restaurant-export-sample.xlsx
```

Do not commit pay-sensitive columns into other fixtures; the app strips `Hourly Rate` / `Labor Cost` on import.
