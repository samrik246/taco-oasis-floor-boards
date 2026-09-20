# Repo
https://github.com/samrik246/taco-oasis-floor-boards

Read `docs/SPEC.md` and `fixtures/` before coding.

# Cursor Agent: Build Taco Oasis Floor Boards Beta

## Operating rules (NON-NEGOTIABLE)
1. **Do not ask the user questions.** Choose sensible defaults from `docs/SPEC.md` and implement.
2. **Build as much as possible** toward the MVP in SPEC.md in one continuous effort.
3. **Test in many slices.** After each vertical slice, run automated tests / scripts and fix failures before moving on. Prefer many small green slices over one big untested dump.
4. If something is ambiguous, pick the option that matches SPEC.md §Defaults. Document the choice in `docs/DECISIONS.md` — do not block.
5. Use the sample file at `fixtures/wheniwork-restaurant-export-sample.xlsx` for all import/parser tests.
6. Ship a runnable local app (`pnpm dev`) with seed/demo path that loads the fixture without manual steps beyond upload (or a "Load sample" button).

## Goal
Scaffold and implement a **beta web app**:
- Upload When I Work Restaurant `.xlsx` export
- Parse `Schedules - Restaurant` (+ optionally ignore Hourly sheet in v1)
- Split rows into **Caja** vs **Cocina** boards by Position string rules in SPEC
- Show day timeline + station grid for a selected date
- Managers can assign/swap people to stations **only inside clock-in/out**
- Enforce one-person-per-station (exception: Nieves can stack)
- Persist assignments + accumulate **hours-by-person-by-station** ledger
- Touch-friendly UI suitable for iPad landscape (kiosk-ish)
- Algorithm for auto-fill is a **stub interface** only in this beta (manual assign works fully)

## Required deliverables
- Next.js (App Router) + TypeScript + Tailwind
- SQLite via Prisma (or Drizzle) for local beta — easy later migrate
- File upload parsing with `exceljs` or `sheetjs`
- Playwright or Vitest+Testing Library for UI; Vitest for domain/rules
- README with run instructions
- `docs/DECISIONS.md` for any defaults you chose
- Green CI script: `pnpm test` and `pnpm test:e2e` (e2e can be headedless playwright)

## Slice order (implement + test each)
See SPEC.md §Build slices. Do them in order. Do not skip tests.

## Done when
- Sample xlsx uploads and produces Caja + Cocina day boards for Sep 18–24 2026 dates in the file
- Manual assign/swap works with rule enforcement
- Hours ledger updates when assignments change
- At least the listed automated slices pass
- `pnpm build` succeeds
