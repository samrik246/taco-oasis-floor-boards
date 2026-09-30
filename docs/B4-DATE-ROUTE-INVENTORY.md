# B4 dated route inventory

Correction to slice 1's today-only ordinary-manager boundary. Route inventory covers `src/app/api/**/route.ts` and the services reached by the dated auxiliary endpoints. A date check authorizes data access, while manager authentication still controls actions that already required it. Owner exceptions read the active database role.

| Routes | Date boundary |
| --- | --- |
| `/api/notes` GET/POST | Validate requested calendar date, authenticate manager, require day access before reads/creates. |
| `/api/notes/[id]` PUT/DELETE | Authenticate manager, load the note's persisted date, require day access before mutation. The body cannot substitute its date. |
| `/api/employees/[id]/hours` GET | Owner-only for every query, including omitted or today `weekOf`. Both station and tarea hours span a week. The caller clears old data and displays an explicit restriction on 403, never zero hours. |
| `/api/performance` GET/POST | Validate real calendar date and require day access before reading/upserting answers. An undated question catalog remains manager-accessible. |
| `/api/tareas` GET/POST | Validate requested calendar date; GET already has day access, POST now checks it before assignment. POST retains manager authentication. Undated templates remain available. |
| `/api/tareas` PATCH | Authorize persisted assignment date. Today's existing staff completion flow remains available; other dates require owner. |
| `/api/position-moves` GET/POST | Validate requested calendar date and require day access. POST retains manager authentication and checks referenced assignment hour/shift dates through the existing assignment helper. |
| `/api/return-prompts` GET/PATCH | Validate requested GET date; PATCH checks persisted prompt date before acknowledgement. Today's staff flow remains available. |
| `/api/imports` POST | After parsing the upload, authorize every parsed date before preview or commit. Ordinary managers may submit only today's data; owner can import across dates. Denied imports do not reach persistence. |
| `/api/sample` GET | Owner-only because the operation imports and paints fixed historical demo dates. |
| `/api/days`, `/api/boards/[board]/days/[date]` | Existing slice-1 day listing/filter and requested-date gate. |
| `/api/assignments`, `/fixed`, `/paint`, `/shift`, `/suggest`, `/copy-day` | Existing requested-date gates; copy checks source and destination. |
| `/api/assignments/[id]`, `/swap`, `/api/admin/seat-plan` | Existing persisted assignment-date checks and applicable requested-date checks. |
| `/api/shift-removals` | Existing requested/stored-date checks. |
| `/api/boards/[board]/days/[date]/overlays` and `/[id]` | Existing today-only mutation routes; overlay service binds cancellation to its board/date/id. |
| `/api/breaks/mine`, `/manage`, `/now`, `/timeline`, `/session` | Existing slice-1 day/gerente checks: server today for worker identity/mutation; owner can read historical BREAK; mutation remains today. |
| `/api/admin/mandatory`, `/changes`, `/manager-pairings` | Owner-only dated data/history. |

The remaining routes have different contracts and are not treated as arbitrary schedule-date selectors:

- `/api/rush`: derives a forecast from recurring weekday percentages. A requested date chooses a weekday; it does not expose dated employee schedules, notes, answers or assignments. `/api/admin/sales` edits recurring weekday configuration.
- `/api/traffic`: dormant simulator state; enabling is refused and the recovery-off operation ignores its optional date/hour fields.
- `/api/imports/now`: existing operational trigger for the configured scheduled importer and its completion status. It accepts no schedule date or uploaded schedule and retains existing manager access. The scheduled CLI import remains unchanged.
- `/api/upcoming`, `/strip`, `/status`, `/print`: the separate existing upcoming-order contract, with current-source membership and print authorization; not floor schedule planning. No print action was run for this correction.
- Employee, station, ability, position-map, manager, tarea-template and authentication routes manage identities or standing configuration rather than dated board records.

Regression coverage: `tests/b4-next-auxiliary-dates.test.ts` exercises ordinary-manager past/today/future access, owner exceptions, denied-write nonmutation, stored-ID paths, omitted/current/future weekly ledger reads, impossible dates, mismatched move date/assignment references and denied upload preview/commit. `e2e/b4-next-ledger-denial.spec.ts` exercises the ordinary-manager hours restriction in the real browser flow. Existing importer tests use owner identity for multi-date fixtures.

No schema or stored BREAK status changes accompany this correction. The unchanged additive migration and same-file compatibility rehearsal remain required at the corrected frozen head.
