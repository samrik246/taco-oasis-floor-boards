# B4 slice 3 — board display and backup schedule

Both boards expose the same read-only REFUERZOS/BACKUP panel below the main content. The current and legacy GM / UP Manager positions and other non-Caja/non-Cocina work appear here; Catering remains excluded. This changes the display projection only. Stored source positions, BREAK eligibility, manager linkage and authority are unchanged. The API applies the existing date-access gate before either projection and returns no abilities or credentials in auxiliary rows.

The panel opens on load, counts unique people, and collapses after 20 seconds without activity. Focus or a held pointer defers collapse. Its header remains reachable for reopening. The existing board/kiosk navigation remains in place.

Pintar now labels its independent count row “Personal programado / Scheduled workers.” Counts include unpainted main-board shifts, deduplicate split shifts, and exclude auxiliary, superseded and removed time. A partially removed hour still counts when at least one minute of scheduled work remains. This is not Horario’s existing assigned-worker count. Painting does not change a scheduled count.

The day payload uses the existing mandatory/extra/recent-use palette order everywhere. Persisted station sort values are unchanged; returned sortOrder represents this shared display order. Pintar’s full palette scrolls with the page. Selected stations and movement reasons use the same saved-label/localization helper as the board.

Horario now isolates marked BREAK/removed/open hours and rejoins the later uninterrupted run. It does not join across a real gap, a seat change, a separate shift or a missing grid hour. This fixes the reproduced four-hour evening fragmentation after an earlier BREAK without hiding that BREAK.

Press feedback applies to board buttons, links, summaries and role buttons, including Refresh. Both locales and both boards have disposable browser fixtures for backup inactivity/focus, joined blocks, scheduled counts, full palette access/order after reauthentication, and press feedback. Unit/API tests exercise classification, public/manager/owner date gates, safe projection, saved routing, ordering, split/partial shifts and removal intervals. The complete package suites retain BREAK, authority, kiosk, offline and private-draft regressions.

Physical tablet acceptance and owner pairing remain separate from browser evidence. Release timing follows the current approved split cutover; no printer behavior is included.
