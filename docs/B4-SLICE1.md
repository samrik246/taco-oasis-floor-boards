# B4 slice 1: BREAK data and authority

This slice supplies the engine contract for the next BREAK screens. It is not a live installation packet. The existing screens are replaced in slice 2.

## Identity and dates

`POST /api/breaks/session` accepts a tablet board and a 4–64 character code. Staff codes remain four digits. It resolves identities across both boards, rejects ambiguous identities, and returns `kind: staff` with a staff token or `kind: gerente` with a manager token, role and idle period. A linked gerente with a floor shift also receives `staffToken` for their own break. Keep those token types separate.

The legacy floor manager login uses the same collision and throttle rules, but ordinary floor access does not grant BREAK authority. BREAK requests re-read active manager linkage and today's effective source shifts. Only `Caja Manager`, `Cocina Guia Abrir` and `Cocina Guia Cerrar` qualify. An unended qualifying shift grants authority earlier that Central day; removal, supersession, midnight and shift end revoke it. Owner authority comes from the current database role. Paint and Switch never grant it.

Ordinary managers see and write today only. Owners retain other-date board planning. Owner BREAK reads can specify another date, while BREAK mutations remain today-only.

## Worker and board data

The existing worker mine endpoint returns shifts and slots from both boards. Each slot includes `board` and `approval: automatic | gerente`. Save resolves a single shift covering the full window; token board is not authorization. Slots are suggestions: save re-reads the rules under the break lock.

Saved data includes `status`, `state`, `board` and `approval`. `ended` represents an unfulfilled request and differs from `completed`. Worker-facing errors omit mandatory-seat reasons.

`GET /api/breaks/timeline` returns both boards' active people, shifts and breaks, ordered by start and stable id. It includes `asOf`, approval/state and current authorized gerente availability. Today is public board data; an explicit historical `date` requires owner access. The UI can derive its pending strip and refresh after cover, rejection and imports.

## Numbered cover

All eight default mandatory 1→2 families use one existing booked-cover record with `auto: false`. The `auto` flag retains its earlier five-minute replacement meaning. Effective assignments must hold for the complete break window, including before 11 AM. Ability, own-break, other-cover and coverage checks still apply. Seat 3 and another board cannot substitute. Cover projection does not rewrite saved paint; import invalidation returns an uncovered booking to pending.

## Owner pairing

`GET /api/admin/manager-pairings` returns safe manager fields and stable employee identities with qualifying role evidence in the last 14 Central dates, plus the window and incomplete-history indication. It never returns codes or hashes. `PUT` requires `{ managerId, employeeId, confirm: true }`; null employeeId unlinks. Only an active owner can read or write it. History suggests a pairing; today's source shifts determine power.

## Additive migration and rehearsal

The only schema addition is plain nullable `Manager.employeeId TEXT`, with no relation. The migration is `python3 scripts/migrate-manager-linkage.py <existing-sqlite-path>`. The script validates first, holds a transaction, executes guarded ALTER ADD COLUMN, checks rowids and integrity, and supports a no-op rerun. Running it on a live database requires the final approved release packet.

`python3 scripts/rehearse-manager-linkage.py` creates a fresh synthetic database and archives source at the pinned old release. It builds and boots old/new/old/new against that same database, exercises old API reads and writes, preserves pending and booked cover rows, proves an old client can create an unpaired manager, and checks retained linkage after rollback. It prints an evidence directory and result file. Fresh synthetic schema bootstrap is the only db-push operation in that rehearsal. No database is copied, backed up, exported or restored.

The final release packet must pin the actual prior live release and hold the shared release lock through actual tablet acceptance. These scripts do not install, roll back or operate the live service.

## Development checks

Run the complete `pnpm test`, `pnpm test:e2e`, `pnpm build` and repository checks. Both test runners use guarded disposable databases. Historical browser fixtures now use synthetic owner access; ordinary-manager privacy and today-only cases retain ordinary-manager access. `scripts/e2e-owner-fixture.ts` changes only the disposable browser-test database, never the normal seed. Independent judgment is against the frozen commit.
