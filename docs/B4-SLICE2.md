# B4 slice 2 — BREAK screens

The accepted slice-1 contracts feed one `BreakWorkspace`, embedded as a full-width board sheet and retained at `/descansos` for direct/spare-tablet entry. The board remains mounted; closing BREAK preserves its board, kiosk lock and paint draft. The entry is available in staff and manager views. No new schema or persisted status value is introduced.

## Screen behavior

- The sheet opens at code entry. One field and keypad accept 4–64 characters without truncation; everyone submits with Entrar. Tokens remain in component memory. Back, Close and expiry clear identity; request generations prevent late responses restoring a closed identity.
- The board strip and entry view show both areas. Pending requests lead, sorted by requested time and stable id. Chips retain area, Central `h:mm AM/PM`, state words and distinct colors. The board strip keeps labeled horizontal overflow; entry and queue group wrapping rows by Cocina then Caja.
- The worker card uses the computed allowance, board/window, persisted state, approval mode and next action. Pending saves are re-read and shown as pending rather than left in the picker. An ended request is explicitly not a completed BREAK. Open times and each duration expose the slice-1 preview; save still revalidates on the server.
- Gerentes see both-area pending requests, simple cover, Shuffle and rejection, plus a separate own-BREAK action when sign-in returned a staff token. Existing Pintar cover controls use the wider dialog and 12-hour times. Owner history is read-only; mutations remain today-only.
- The owner pairing panel shows safe manager display names and linkage, the 14-day Central window, incomplete retained-history notice, and deduplicated schedule candidates with qualifying source-position names. Selection never writes until Confirm. Cancel leaves the database alone. The API keeps enforcing owner-only access.
- The saved card closes after 10 seconds. Staff idle remains 60 seconds, entry idle 30 seconds, gerente idle uses the server-issued duration. Throttle pause remains one minute. Manual refresh, 15-second refresh and focus refresh recheck gerente authority through `GET /api/breaks/session`; that route reads current active role/linkage/schedule. Revocation clears the queue and credentials. Action routes independently recheck authority.
- Exact ES/EN approval and pending copy lives in `lib/breaks/display.ts` and the workspace. The existing internal log actor `Descansos` is retained; displayed BREAK controls and messages use BREAK. The pending fallback text describes an attempt, possible 15-minute postponement or an ended request.

## Regression map

| R2 requirement | Implementation / evidence |
|---|---|
| 8 landscape/full width; 11 back/close; 20 direct entry | `BreakWorkspace`, `FloorBoard`, `DescansosScreen`; workspace e2e and retained kiosk e2e |
| 9 Central 12-hour times | shared display helper, manager dialog, Ahora and painted break stripe; unit and browser assertions |
| 10 computed maximum allowance; 12 status/action | worker card; existing allowance engine tests plus rendered assertions |
| 13 cross-board identity/reservation; 15 shared list | unchanged slice-1 engine, shared strip, actual long-credential cross-tablet e2e and worker preview e2e |
| 14 Gerente; 16 pending and preview; 17 refresh | persisted mine reload, session refresh, both-area polling; status/persistence/denial tests |
| 18 strip above Horario with overflow | board placement and overflow region; landscape browser screenshot |
| 19 BREAK naming | UI and API message updates; internal log actor deliberately unchanged |
| 21 date boundary | slice-1 API regressions retained; owner-only history control and revoked-session test |
| Queue/simple cover/Shuffle/reject | existing engine tests plus UI payload regressions and actual queue screen |
| Owner pairing | real synthetic owner selection/confirm/readback, ordinary-manager controls absent; server pairing regressions retained |
| 22–23 Resto and Hora/Puesto/Día/Resto | existing full browser suite retained |

`e2e/b4-slice2-workspace.spec.ts` captures actual rendered screens using only synthetic identities. Some presentation cases use mocked API responses to make all states reproducible; the manager credential, own-break, pairing and revocation case uses the real disposable test server/database. These screens are a design review artifact, not physical-tablet or installation acceptance.

The managed-read DTO now includes the same approval classification as the worker/timeline DTO. This is additive response data, without a storage change. All accepted slice-1 identity, boundary, numbered-cover and compatibility tests remain in the complete suite. The old/new rehearsal scripts and migration are unchanged.

## Remaining gates

Independent judgment must use the frozen commit, complete tests/e2e/fresh build, required artifact checks, attribution and the unchanged lint baseline disposition. Richard's actual screen review and final installation approval remain later gates. Saved-label readback, slice 3, release-chain review, and physical Caja/Cocina tablet acceptance remain in R2. This slice does not install, alter a live display, run an import or push an unjudged commit.


## Navigation/copy correction

The pending-review dialog has distinct Back and Close controls: Back dismisses one phase to the gerente queue; Close invokes the workspace reset and returns to the board. Ordinary Pintar callers and successful saves still dismiss just the dialog. A dialog request generation invalidates load/mutation responses on dismissal, unmount or identity change, including deferred JSON and deferred refresh completion. Escape follows one-step Back.

Disabled slot faces display generic `No disponible` / `Unavailable`; dialog buttons, allowance and range text follow the current locale. The Ahora Suspense fallback says BREAK. Rendered interaction regressions are in `tests/b4-slice2-dialog-exits.test.ts`; both-locale board return, fresh code entry on reopening and delayed-mutation cases are in the complete workspace browser suite.

Each browser run now writes captures into its own `FLOOR_BOARDS_TEST_ROOT/b4-slice2-screens` directory. A review packet copies the eight publication images to a separately sealed evidence directory and records their hashes and the source commit. Judge reruns cannot overwrite the publication captures through the test configuration. The original packet remains prior evidence; only a newly judged corrected packet may be posted.

## Owner screen correction

The owner review replaces the entry-mode toggle with one masked 4–64-character field, a numeric keypad and explicit Entrar for everyone. Four digits no longer submit automatically; typing/paste and keypad feed the same field. Server identity, collision, throttling and authority checks are unchanged.

Entry and gerente queue lists group Cocina above Caja, with pending-first/time/id ordering inside each area. Cards wrap without horizontal scrolling. Eight example requests and the entry controls fit a 1280×800 landscape viewport in both languages. Dense/long-name sets retain every request and grow vertically with normal sheet scrolling rather than hiding or shrinking content; physical tablet acceptance is still separate. The board's compact strip retains its original horizontal overflow.

Gerente status uses a labeled amber pending or blue reserved/approved heading. Cover and Mezclar/Shuffle actions have distinct labeled colors and show the chosen cover while saving; rejection is a separate red action. Ended requests keep their factual ended wording. No rejection status is stored. Existing one-tap cover, Back/Close, shared Pintar, expiry and delayed-response contracts remain.

`e2e/fixtures/b4-review.ts` creates an eight-hour synthetic crew with all mandatory Cocina seats filled and no numbered partner for its Guia. Worker options come from production placement and coverage functions, including allowance/blackouts and complete intervals. Simple and two-move covers come from the production cover list. The screenshots show four valid durations at 2 PM with coherent gerente approval; automatic morning options and multiple alternative starts remain available. Reservation editing is exercised at 2:15 PM for 45 minutes. No live roster or credentials are used.

New viewport captures supplement the eight versioned review images. Dense-case captures are explicitly full-page evidence of retained rows, not a viewport-fit claim. Earlier packets remain immutable prior evidence.
