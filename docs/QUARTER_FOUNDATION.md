# Quarter storage and server foundation

This is the first server slice of the accepted quarter-paint contract, based on
accepted display source `7b08a8a`. It is **not** the compatible recovery artifact
R0 and cannot activate quarter painting on the installation.

## Database states

- No quarter schema: accepted hourly behavior.
- `prepared`: six additive tables and their constraints/triggers exist. Hourly
  reads/writes remain available; interval commands refuse `QUARTER_NOT_ACTIVE`.
- `active`: supported only in disposable test databases by this foundation.
  Startup and import entry points refuse an active database outside the established
  test root, using the shared positive disposable-path guard and a configured/actual
  connection match. Symlink, ancestor-root and alternate-database overrides refuse. Legacy paint/import/removal/task consumers refuse upgrade instead of
  reading or overwriting mixed interval paint.

The `GET /api/paint/capabilities` handshake advertises `artifactRole: foundation`,
`activation: false`, `recovery: false` and `quarterUi: false`. No activation command
is provided. Old hourly deployment/recovery scripts refuse the additive schema;
this refusal is not a substitute for the future compatible controller.

## Prepared migration

`pnpm exec tsx scripts/quarter-migrate.ts` acquires the existing release lease,
identified from the loaded artifact root (independent of the launch directory),
then the shared database mutex, verifies the existing preservation columns and
source storage, installs the exact six-table DDL and verifies every table/index/
trigger. Repeating it preserves the epoch. Partial schema or drift refuses.
`db:push` and `db:setup` refuse a database that already has the quarter schema.
The browser harness migrates its new synthetic database to prepared before the
fresh production build; ordinary browser regressions therefore exercise prepared.

This document describes the command; running it on the installed database remains
an installation action requiring the owner's separate go.

## Server interfaces

Mutation JSON uses `application/vnd.floor-boards.paint-v2+json` and
`X-Floor-Boards-Protocol: 2`. JSON bodies are bounded to 2 MiB; paint commands allow
500 adopted hours (including peers) and 2,000 intents. Sources, revisions and
capability hashes must come from the matching V2 read. Actors come from server
authentication. No client flag grants a release lease or manager authority.

| Interface | Purpose |
| --- | --- |
| GET `/api/v2/boards/{board}/days/{date}` | Safe explicit interval/source/revision DTO, both-board cover evidence; removed sources excluded |
| PUT `/api/v2/assignments/paint` | Quarter/hour station, family or erase; full atomic validation |
| POST `/api/v2/assignments/operations` | Whole-shift, atomic swap and explicit preview/commit copy |
| GET `/api/v2/assignments/paint/receipts/{requestId}` | Current manager's exact durable result with every original date reauthorized |
| GET `/api/v2/assignments/history` | Manager-only interval audit summary; no source/legacy snapshots |
| GET `/api/v2/assignments/suggest` | Exact-interval favorites and original world revision |
| PUT `/api/v2/agent/paint` | Same authenticated paint protocol, limits and receipts |
| POST `/api/v2/shift-removals` | Source/revision-bound remove and exact snapshot restore |
| POST `/api/v2/imports` | Workbook preview/commit with `X-Floor-Boards-Capability` and protocol 2 headers |
| POST `/api/v2/tareas` | Atomic task assignment/status with revision and receipt |
| GET `/api/v2/tareas/suggest` | Exact-interval task suggestions, without numeric ability scores |

All applicable day/owner gates remain in force. Staff can retain their existing
same-day task status action; assigning a task requires manager authority. The
existing task return resolves the actual base interval at the current instant;
it never restores an erased Assignment row.

## Transaction and compatibility rules

`StaffBreakLock` is the first statement in every affected write transaction.
Current HTTP authorization runs first. Exact actor/request/hash/epoch receipts
replay before comparing the current capability hash or revisions; an altered payload with
the same actor/request identity refuses. Source/hour/world expectations are checked
before staging departures and arrivals. Hour revisions advance once per command.
Paint mutations, audit, source changes and response receipt commit together.

An adopted hour wholly replaces legacy Assignment interpretation. Erasure is
explicit. Off-shift fragments remain off; a source ending at :20 contributes only
five factual minutes in its last quarter. Cover eligibility still needs the full
quarter. Whole-hour convenience writes refuse mixed or obligated hours.

Numbered-family peers are projected before editing and adopted together, so the
legacy null-seat backfill cannot run in active mode. Existing bookings/overlays,
both Shuffle movers, and outgoing origin absence/return use exact recorded source
identities and intervals. Source-only DML on adopted paint is independently guarded.

Import preview/save includes the source/world revision. Both hourly and direct
folder entry points check compatibility after acquiring the shared release lease.
The parsed-schedule fingerprint maps to actor `system:import-v2` in
`PaintCommandReceipt`; retries return its original result/skip list. Future unique
takeovers retain interval erasures; started-hour changes preserve history. Optional
fixed placements skip/report conflicts; import reconciliation itself is atomic.
Prepared mode retains its accepted duplicate-import response. Legacy imports with
no compatible receipt include safe original batch metadata rather than fabricated
result/skip lists. Folder replay is labeled `replayed` and keeps the original result.

Raw Prisma INTEGER epoch results are cast to TEXT and decoded as safe epoch
numbers; revisions remain decimal strings. See the synthetic regression coverage
in `tests/quarter-foundation.test.ts` and `tests/quarter-adapters.test.ts`.

## Remaining R0/Q1 inventory

| Stage | Required work before activation |
| --- | --- |
| R0 client consumers | V2 schedule/timeline/floor/wall/editor, admin/import/removal presentation, agent CLI read/command flow; H15 station-use/palette ordering; all 27 contract reader dispositions |
| R0 draft/cache | Explicit V2 cache sanitization; IndexedDB CAS on the existing remote HTTP origin; immutable generations, V1 retention, receipt cleanup and episode rules |
| R0 release/recovery | Real artifact manifest and independently pinned R0; schema/client evidence preflight; lease-held promotion and both rollback/exception recovery paths |
| R0 preservation | Extend packet capture to all 26 table allowlists and browser stores; successful writes during checker wait followed by rejection/timeout, exact same-file preservation and fixed-now picker/import proofs in both artifacts |
| Q1 interactions | Quarter painting and four-times horizontal zoom, exact icon/color/centering behavior and scheduled counts; mixed-hour feedback and narrow-fragment legibility |
| Whole version | Independent complete-package, browser, compatibility, recovery and physical-tablet judgment; later time-block notes/alerts and their own authoritative preservation state |

`src/lib/quarter/preservation.ts` provides the exact 26-table column registry and
safe hash capture for synthetic migration evidence. The foundation's registry is
not a completed release packet, activation readback or recovery proof. No device
readbacks, R0/Q1 artifact pins, staff messages or live writes are claimed here.

Public visibility filters sources, employees, hours and cover evidence together.
Superseded assigned history and cross-board cover identities remain visible; the
canonical resolver, ledger and authorized removal review keep removal history.

Cancellation takes StaffBreakLock before reading overlay state. The hourly
position-move POST and helper refuse active mode before legacy audit DML; its
prepared behavior and historical reads remain. Quarter moves use PaintMutation.
Legacy traffic/position-map seed writes invalidate world expectations through the
world triggers; their explicit R0/server dispositions and concurrency evidence
remain in the all-reader/writer inventory.
