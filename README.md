# Taco Oasis Floor Boards (Beta Spec)

Live **Cashiers** + **Kitchen** station boards for iPad/monitor.

**Repo:** https://github.com/samrik246/taco-oasis-floor-boards

Upload a When I Work–style Restaurant schedule `.xlsx`, split **Caja** vs **Cocina**, assign people to stations inside their shift windows, track hours by position. Auto-fill algorithm comes later (stub only in beta).

## For Cursor
1. Clone this repo
2. Paste the entire contents of [`prompts/PASTE_INTO_CURSOR.md`](prompts/PASTE_INTO_CURSOR.md) into Cursor Agent / Cloud Agent
3. That prompt says: **do not ask questions — build and test in slices**
4. Always treat [`docs/SPEC.md`](docs/SPEC.md) as the source of truth

## Docs
- [`docs/SPEC.md`](docs/SPEC.md) — full product, data model, rules, MVP, test slices
- [`prompts/CURSOR_BUILD_BETA.md`](prompts/CURSOR_BUILD_BETA.md) — short build brief
- [`prompts/PASTE_INTO_CURSOR.md`](prompts/PASTE_INTO_CURSOR.md) — **long copy-paste prompt**

## Sample fixture
`fixtures/wheniwork-restaurant-export-sample.xlsx`
- Sheet `Schedules - Restaurant` (required shifts)
- Sheet `Hourly - Restaurant` (optional; ignore in v1)

## Quick start (after agent scaffolds the app)
```bash
pnpm i
pnpm dev
# http://localhost:3000 → Load sample
```
