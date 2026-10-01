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
