# Receipt picker and diagnostics — offline host boundary

This next-version slice supplies `/receipts`, the manager Imprimir entry in
`/next`, a closed V4 browser/host boundary and a component that accepts fake
engine dependencies for tests. The production route deliberately supplies no
engine. It cannot spawn Python, query a device, provision state or send paper.
There is no browser or environment switch that enables the fake.

The current upcoming-order projection supplies display tails, not authoritative
content handles. Its picker therefore holds content until the trusted producer
and owned-handle catalog are integrated. Never mint document identity from a
tail or accept client source IDs/hashes. The old PrintButton is no longer
mounted in NEXT; the gated legacy endpoint remains for its existing owner and
must be retired before real receipt integration so the engine is the only sender.
Unreadable legacy history now returns unavailable, never printed:false.

## Frozen boundaries

- V4 contract: `2836799c5c2eface28a733684bfcdf89961ddf2c9f8d96d3eff55fc6cea5e133`.
- Spanish wording V3: `feace51ac259a972d6658fe1e6d12291a1b8d8c45d3c3c3645dd1c5c7ef0494e`.
- Shared fixture V2 in `fixtures/receipts/v4-examples.json`:
  `ff38147c7ad065a5b231e41c280c74adb90cc772b84ed3ff9394d8eed7d703e3`.

Every request checks an active manager and the existing session-header/origin
boundary. Strict schemas reject unknown and duplicate keys, malformed UTF-8,
wrong scalar types and oversized messages. Server-owned content/review mappings
replace browser handles; validated projections remove private plan/content
hashes. Wrong correlation, incomplete/malformed output or missing dependencies
stay unavailable. Engine durability, ownership mappings and uniqueness remain
engine/host-integration obligations, not in-memory mock claims.

Engine result framing requires exactly one terminal LF, with no other LF or CR.
The complete untrimmed UTF-8 frame, including that LF, is limited to 65,536 bytes.
Malformed framing cannot create a remembered review binding or a positive no-send
claim. The future child collector must separately enforce this bound while reading;
the current injected string dependency does not implement a pipe collector.

Order destinations and saved defaults are separate. Reviews retain ordered
customer-free lines, destinations, one copy per document, totals and expiry;
submit carries only the immutable review handle. Per-document outcomes retain
uncertainty. Retry, same-reservation re-review and observed CAMBIO stay distinct.
The manager-scoped session journal stores request IDs/operations only, before
mutating requests. Missing responses, reloads and unavailable history require
explicit original-ID recovery; no automatic query, retry or resend occurs.
Corrupt/inaccessible session storage prevents mutation. This journal is a local
recovery aid, not the engine's durable record or cross-tablet deduplication.

All nine canonical printers appear. Cached reads and explicit one-device refresh
are separate; opening the screen makes no request. The UI keeps last-request and
last-valid timestamps separate and ages old observations locally. Test preparation
requires a one-ticket preview and a second deliberate submit. Transmitted means
paper still needs checking; it never records acceptance automatically.

## Evidence and remaining integration

The package tests exercise exact fixture schemas/projection, auth and malformed
boundaries, component interaction/recovery, and synthetic both-language browser
renders. Those examples do not execute engine transactions or printer I/O.
Complete package commands remain `pnpm test`, `pnpm test:e2e` (fresh build),
`pnpm exec tsc --noEmit`, and the existing lint/static checks under disposable data.

Real Node→Python execution, authenticated owned-handle storage, trusted catalog,
child READY/source/interpreter/cache-prefix verification, provisioning, separate
gates, physical identity/profile commissioning and attended paper proof remain
outside this slice. Real installation/enablement requires its separate owner go.
No current-version release packet contains these changes.

## Private adapter V2 dispatch

The injected host dependency implements the agreed private API V2
`cfd5978caadf61b7d6b91f03b18d1d7a4c34480b9ef4fc6e56f845a2dd6fda38`.
It does not change frozen V4 wire fields. Production still supplies no engine.

After authentication and schema validation, the host snapshots and recursively
freezes the complete browser command and authenticated actor. For prepare,
prepare_test, re_review, submit, observe and save_defaults, required lookupRequest
runs before any mutable handle resolution. Only an exact absent result proceeds.
Bound/conflict/unavailable results pass the same strict framing, size, correlation
and projection checks; conflict must be refused/request_conflict/null, and
unavailable must be unavailable/history_unavailable/null. Missing lookup support,
malformed variants and unknown exceptions cannot become absence. Execute receives
the identical immutable context alongside the translated private command.

Typed content/plan resolution distinguishes known unavailable history, known
unavailable source and unauthorized handles. Those pre-dispatch outcomes produce
correlated null-data responses with no execute call (503 unavailable, 403
unauthorized). Unknown throws and malformed outcomes retain the operation's
existing unavailable/unconfirmed mapping, without exposing exception text.
Read-only operations and diagnostic status_refresh create no new browser
association through this dispatch path.

Review/content mappings belong to retained engine history. The host does not
write a rememberReview cache after projection. A restarted host must obtain its
mapping through the engine's plan resolution; a lost response must use durable
lookup/recovery. There is no second B4 request ledger or association repair.

Tests inject fake lookup/translation/execute results to establish the host call
order, immutable context, failure handling and projection. They do not establish
origin migration, cross-namespace absence, transaction races, accepted/refused
atomic associations or durable mapping retention. Igor's engine must repeat the
same lookup in its acceptance transaction and validate mappings there. The real
collector, child integrity/READY, ownership/deadlines and legacy sender exclusion
remain separate integration obligations before any real injection or enablement.

## Resident transport V2 — injected implementation

The next offline boundary implements the B4 side of private transport V2
`8b9e76422d7f39024a1084f1d4486c3105ace70bc195d5021d07d1a5effd873f`.
`transport-codec.ts` produces canonical bounded calls and incrementally collects
1,024-byte headers plus raw bodies (65,536-byte result or 8,192-byte Resolution).
Result bytes retain the existing G2 framing/correlation checks. Oversize, invalid
UTF-8, duplicate keys, extra/late frames and invalid kind/body combinations poison
the generation; none can establish positive absence. Queued calls retain an
immutable canonical template; only its fixed-width server UTC slot is filled at
dispatch. Arrays, nulls and all authenticated browser fields remain unchanged.

`transport-config.ts` validates config bytes, both retained inventories, their
canonical hashes, root/catalog agreement and closed schemas. It does not inspect
the filesystem or authenticate a caller's claimed integrity result. The trusted
release config selects a compatible accepted schema5 ControlStore with both
retained attestations. It cannot initialize, migrate, refresh an inventory or
choose an older constructor dynamically.

`transport-supervisor.ts` requires injected runtime verification, spawning,
process-group cleanup/proof, clock and retained lifecycle-record dependencies.
There is deliberately no installed implementation of these dependencies and no
default child_process launcher. Its tests supply fake workers and fake integrity
proofs. A real H implementation must establish interpreter/import identities,
effective service non-writability of release/config/ancestors including ACLs,
environment/cache predicates and the accepted engine constructor. A collection
of true flags in a fake is not such proof.

Only an explicit trusted lifecycle call starts/restarts a worker, after proven
prior absence and retained startup evidence. Calls never start it. The supervisor
checks actual injected spawn PID/group, generation and pinned READY identities;
uses one active call, at most 32 waiting calls and two-second queue expiry; and
includes writes/backpressure in the ten-second response deadline. TERM and KILL
each have a two-second closure window. Pipe closure or a PID alone never releases
ownership; unresolved descendant/reap proof blocks replacement. The injected
group operations must bind to actual spawn provenance before real integration.
Lifecycle persistence is separate from the engine request/outcome history.
Read/proof dependencies at startup each have a ten-second bound; journal writes
have a two-second bound. A failed or stalled journal permanently inhibits this
supervisor instance, including after a late write completion. Writes retain
their actual serial ordering. After one unresolved TERM/KILL sequence, repeated
stop calls do not signal again; a fresh externally proven lifecycle boundary is
required. These bookkeeping bounds add no automatic restart or process adoption.

`resident-adapter.ts` maps the four private methods into DurableReceiptAdapter.
Known pre-dispatch history failures retain their typed unavailable mapping;
unknown completion preserves original-request uncertainty without retry.
Authenticated status_refresh returns fixed refused/gate_off with no worker call,
history write or query. Cached reads do not fall back to a diagnostic action.
Malformed semantic result/Resolution data also retires the worker generation.
The active call keeps the serial slot through full semantic validation, before
another queued call can write. A syntactically valid but contradictory response
cannot release queued work before the facade notices it.

The production route continues to inject no engine. The Python worker belongs to
the engine owner; no Python main, socket, sender, second ledger, environment
activation switch or service change is supplied here. Real Node/Python golden
bytes and persistence, schema5 constructor behavior, hard worker self-deadline,
parent death and actual group reaping require the independently judged pair and
real OS tests. Protected-release provisioning, legacy-sender exclusion, trusted
content/grants and paper activation remain separate gates. The adopted projection boundary is described below.


## Unfinished and closed-send projection

The public validator uses the effective submit state/reason, including inside a
successful original-ID recovery. Accepted unfinished rows all carry attempts.
Pending/null and unfinished unavailable/result_unconfirmed permit only recover
on every row, including a transmitted prefix. Validated history_unavailable
retains its separate envelope. Terminal aggregates, row reasons/observations and
non-accepted ReviewData retain separate checks. Complete serialized public
wrappers, including the final LF, remain bounded to 65,536 UTF-8 bytes.

The interface labels checkpoint state and time separately from the current
aggregate outcome. A pending result says Send in progress; a lost positive proof
says Paper may have printed and retains recorded facts. Neither state causes
polling, resending or another mutation. Only deliberate original-ID recovery
changes that projection; recovery ok means retrieval, not paper success.

Displayed groups retain effective original submit ID plus plan_handle. Rows are
keyed within that group; sharing a reservation, attempt or current revision
cannot collapse two sends. A closed earlier send retains its own state, time,
null observation and empty continuation actions through successor activity.
Not-attempted wording is scoped to that send. A successful older read cannot
clear a newer unresolved request or replace its pending notice.

A validated successful successor re_review (direct or recovered) also hides
the earlier closed membership's stale continuation controls immediately, before
the successor is submitted. This is a transient per-group/per-reservation UI
mask: received row facts and allowed_actions are preserved, unrelated rows and
groups keep their controls, and replay of that old group cannot restore the
stale controls. Refused, malformed, same-plan or older-revision reviews do not
establish this suppression. No automatic read or durable state update occurs.

Observe still names only attempt_id publicly. The view retains the selected
claimed group and validates matching row identity/state before updating only
that group. A recovered observation with no selected membership asks for a
deliberate original-send read and changes no displayed group. These display
bindings do not replace authoritative engine membership, history or permissions.

Pinned test intake:
- Unfinished V2: e02e6f8bf27fbde7b22c58472e2c639c5421d1c01ba7664e0e6c184e1968bbd6.
- Overlay V1: d4abc41f9f99323b33f9f2d411bd5c3c4e327ded3d97a7e492b65df537f9f8e4.
- Shared/wire baselines remain ff38147c7ad065a5b231e41c280c74adb90cc772b84ed3ff9394d8eed7d703e3
  and 94ff82505930ee5d43ded728f3d5354381241966a86b0070d84546b95ca724ca.
- Closed-send accepted boundary: d295a4c06c3501a6a8c689f45bc9c625c3d05dd256d14e9f09cf28fbae74f482.
  Copied document examples retain all three source hashes in
  fixtures/receipts/closed-batch-examples-v1.json.

The overlay verifies both hashes and the unique V4-14/active-coordinator/
read-aggregate selector, changing only the test expectation in memory. Its
unchanged observe response is a negative control through the actual validator.
No production response is repaired. Eight engine-context negatives N15–N19 and
N23–N25 remain outside stateless validation acceptance. Synthetic transition and
browser tests do not establish durable engine, worker ownership or paper proof.
Production still injects no engine.
