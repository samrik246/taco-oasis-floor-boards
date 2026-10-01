# Saved BREAK cover display

The public day read now supplies `coverDisplay` version 1. A read-only transaction selects explicit public shift/assignment/station fields, booked break identities and overlays for both boards. The pure projection validates the exact recorded requester, cover and Shuffle shifts against the employee, date, live state and complete interval. Missing, ambiguous, removed or mismatched evidence produces an unavailable notice; another shift is never selected to repair it. Both Shuffle legs must be supported before either is shown.

Saved movement segments include the destination and original seat, split at saved assignment/overlay boundaries, together with the person's work before and after. Incoming cover and outgoing absence come from the same projection. No Assignment, StaffBreak, overlay or schema write is added. The booking engine and approval policy are unchanged.

Horario, Timeline and Pintar show exact proportional segments in marked hours. Pintar keeps a pending paint edit separate from its saved annotation. Supplemental cover rows remain outside collapsed BACKUP/REFUERZOS and outside `day.shifts`; scheduled headcounts and auxiliary totals keep their existing meaning. Floor and wall station occupants use saved intervals for affected seats. Existing whole-hour edit controls are not attached to supplemental movements.

The cache applies the same explicit `coverDisplay` allowlist on save and read. Old snapshots show known BREAK intervals and unavailable cover detail. They do not choose a cover from an employee ID. No abilities, email, external employee codes or manager fields are introduced into this projection.

Development evidence must include the complete unit/API and browser suites and a fresh production browser build. Synthetic browser tests measure half-hour widths/offsets and capture both boards/locales in schedule, paint, floor and wall. These checks do not establish physical-tablet acceptance or permission to install. Quarter-paint storage and zoom remain a separate contract.

Owner planning decisions on October 1 approve each cover's own named row and retain Personal programado as scheduled workers (including BREAK), with backup counts separate. The preserved first-slice draft resumes under those decisions; this display change does not implement quarter paint, notes or alerts. All later slices retain their separate technical and independent review boundaries.

The wall filters affected seats at the current instant with start-inclusive/end-exclusive bounds, so a returning worker replaces the cover exactly at the handover time. The floor retains the complete selected-hour occupant summary. The wall's separate interval table shows that hour's BREAK, cover and return spans, while large station names identify only current occupants.
