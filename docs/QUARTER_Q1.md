# Quarter editing and grid candidate Q1

Q1 uses the accepted R0 schema, V2 protocol, receipt identities and IndexedDB
envelopes. It adds quarter painting/erase to the active color editor and an aligned
hour/quarter grid to the active editor and staff timeline. Prepared mode retains
the hourly interface. Notes remain disabled.

The blue `>#<` control below the selected clock in the Scheduled workers corner
opens fourfold horizontal zoom; the orange `<#>` restores the overview. Time rows
keep their height. The selected hour is centered in the area beside the fixed name
column, with normal scrolling to both ends. Hour/column boundaries are dashed;
quarter guides are lighter and cannot capture a pointer. Each quarter's count is
the number of distinct scheduled people with at least one remaining contiguous
minute, after removals. BREAK, unpainted work and sequential same-person sources
do not inflate that count, and derived cover rows never add people.

Whole-hour convenience editing retains the R0 guard. A mixed or obligated hour,
or an hour containing private quarter work, shows its reason beside the tapped
cell and offers quarter editing. Saved BREAK/movement intervals remain guarded.
The server validates occupancy and all source/revision expectations atomically.
Rejected saves retain the draft and report the rejection beside the last edited
cell as well as in the save status. A mouse drag retains its visited cells in one
CAS update; touch swipes remain scrolling, and taps/keyboard activation edit a
single cell. Exact interval detail is readable below the grid when a cell is
focused or selected, including narrow partial-shift fragments.

Quarter changes preserve sibling intent IDs and original source/hour/world
expectations. Narrowing a private whole-hour proposal expands it into its factual
quarters in a new immutable generation before replacing the selected quarter.
An in-flight submission keeps its exact original bytes. Existing storage-failure,
review-only, receipt cleanup and newer-intent behavior remain required. Q1's new
quarter UI checks the current server capability; a loaded Q1 page cannot start a
new quarter proposal against an R0 server that advertises quarterUi:false.

The sealer identifies these actual built bytes as QP_UI_Q1 with quarterUi:true.
This capability is not activation or independent acceptance. The R0 recovery
runtime remains separately pinned and its original flags are never rewritten.

## Qualification packet

The Q1 rehearsal init requires explicit `--accepted-r0` and
`--accepted-r0-manifest` arguments. It copies that runtime into its disposable
root and copies the current Q1 separately; it refuses a missing, same-source or
non-R0 recovery artifact. The production controller and preservation registry are
unchanged. The packet must carry independent acceptance evidence for both exact
artifact pins before actual composed qualification is released.

The six actual cases cover R0→Q1→R0→Q1, explicit rollback, checker rejection,
checker timeout, blocked recovery/offline and incompatible-target refusal. In
addition to the retained HTTP/storage probes, the actual Q1 editor saves through
its built page, loses an acknowledged response and retains a newer private
quarter. The actual R0 editor then reconciles the receipt and retains that newer
work; the round trip returns to the actual Q1 page. Each loaded page answers a
challenge with its compiled source identity and static digest. Offline inspection
compares retained bytes without claiming a running application. These proofs use
separate synthetic profiles on ordinary HTTP; no fixture-injected module is
substituted for the actual loaded editor.

Importer, host and picker proofs run at both real artifact pins on the same file.
When replaying a host command after cutover, only its outer artifact attestation
is rebound to the currently loaded runtime; the request, expectations and receipt
remain unchanged. The final aggregate refuses missing cases, loaded-bundle
records, pending evidence, inconsistent artifact pins or unresolved cleanup.

Activation qualification retains immediate before/after safe-column guards and
typed QuarterSchema/QuarterWorldRevision rows before validating them, including
on failure. It requires prepared→active, reader/writer 1→2, an activation time
inside the observed boundary and exactly one world-revision increment from the
actual schema-update trigger. Database identity, schema, epoch, migration,
registry, foreign-key guarantees and every other table must remain unchanged.
The completion record binds both snapshots and the activation journal; final
Q1 aggregation checks their hashes and revalidates the exact transition.

Scenario preservation baselines follow the final authenticated read: the client
helper signs in even in read mode, which updates the safe lock rows. Each strict
crossing retains both 26-table guards and typed safe lock rows before assertions;
failed actions retain the immediate after snapshot too. The roundtrip additionally
retains pre-read rows so the authentication side effect can be diagnosed without
credentials or sessions. Completion and Q1 aggregation bind and revalidate every
boundary, including refusal and return-to-candidate. No lock table is exempted
from the strict crossing checks; controller stopped-state checks remain unchanged.

Complete unit/API, fresh production browser, typecheck, packet, static and
normalized lint checks and source-bound screenshots precede the frozen handoff.
Actual composed execution needs the independent pin/packet review. Physical
tablets, installed services/configuration, activation and printing retain their
separate attended gates. Q1 must receive independent judgment before Release A's
remaining controls, Inicio and print-preservation slice.
