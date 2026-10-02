# Release A interface and navigation

`/inicio` is a bilingual navigation page. It carries only a board selection in
links to the floor, wall, NEXT, BREAK, Now and Administration. Administration is
labeled as manager sign-in; the home page does not expose owner tabs, load
privileged data, store a token or authenticate another area. The existing floor
memory session and back-office session storage remain separate. Destination
routes and APIs keep their existing active-manager, owner, date and origin
checks. Root `FloorEntry`, `wall=1`/`wall=true` and existing staff entries remain.
Kiosk BREAK/Now navigation stays hidden. Unfinished `/receipts` has no home or
NEXT menu entry; its direct route and API remain guarded.

The floor header keeps Hide/Show in a dedicated top-right row in expanded and
folded views. Folding does not remount the editor. Retained private paint stays
in its existing stores during Inicio navigation; the new return link refuses
navigation while the editor is busy or a change is still unretained in memory.
The manager must unlock the destination through its existing access flow.

Hourly and quarter paint refusals use a fixed callout outside the table's
overflow context. It follows scroll/resize and the visual viewport, stays below
the floor toolbar and can scroll internally on small screens. The affected
cell describes that alert. A persistent summary lists the affected cells and
lets keyboard/touch users return to each one. A refused multi-cell operation
retains the complete draft; these display changes do not alter grid widths,
row heights, cover projection, draft envelopes, receipts or saved data.

NEXT again mounts the existing PrintButton, keyed by order tail, with per-order
uncertainty retained for the visit. A synchronous in-flight latch excludes
repeated taps during manager unlock and sending. Off, unavailable or unreadable
history stays hidden. The legacy API's `history_unavailable` refusal remains.
See [receipt boundary](RECEIPTS-OFFLINE.md) for the separate unfinished sender.

Coverage is included in the complete package and fresh-build browser suites:

| Requirement | Evidence source |
| --- | --- |
| Bilingual home, six destinations, return links, separate authentication, no receipt menu | `e2e/release-a-interface.spec.ts` |
| Narrow/folded/scrolled top-right control | `e2e/release-a-interface.spec.ts` |
| Both boards/locales/themes, legacy cell feedback | `e2e/b4-slice3-board.spec.ts` |
| Actual quarter draft round trip, retained bytes, multiple-cell errors, geometry and visual matrix | `e2e/quarter-q1.spec.ts`, `e2e/fixtures/q1-visibility.ts` |
| Print mount/off/history/network/expired/per-order uncertainty | `e2e/release-a-interface.spec.ts` |
| Repeated tap during unlock/send, cancellation, lost response | `tests/release-a-print-button.test.ts` |
| Existing active/revoked/downgraded roles and direct API guards | `tests/b3-s1-roles.test.ts`, `e2e/b3-s1-roles.spec.ts`, `tests/receipts-manager-route.test.ts` and the existing day-access/session suites |
| Legacy API and synthetic loopback transport safeguards | `tests/t4g-imprimir.test.ts`, `tests/t4g-imprimir-real.test.ts` |

Browser print responses are synthetic route fixtures; no physical transport is
enabled by these checks. Full check results must be bound to the exact source
freeze and independently reviewed. Accepted R0/Q1 artifacts remain frozen.
Any successor composed qualification needs a new packet and separate release.
Physical tablets and installed/live/print acceptance remain separate gates.
