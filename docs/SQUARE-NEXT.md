# SQUARE NEXT — upcoming Tacos4Groups orders

Page `/next`. A calendar of upcoming Tacos4Groups orders; tap one to read its
kitchen detail. Supervisors pick month, week, or list, the language, and which
details show; the choice is kept on that tablet (`taco-oasis-next-prefs-v1`).

**Dark by default.** With `NEXT_SOURCE` unset the page serves no orders and the
floor header hides its **Tacos4Groups** link (`/api/upcoming/status`).

## Where the orders come from

One adapter, `src/lib/upcoming/source.ts`:

| `NEXT_SOURCE` | Source | Notes |
|---|---|---|
| unset / anything else | off | No orders, no floor link. |
| `fixture` | `fixtures/square-next/orders.json` | Test switch only. The three real C1 kitchen records (tails AgIeZY, hj35YY, sr0GZY). The page shows a **Test data** badge. |
| `sheet` | C1's read-only link | Needs `C1_NEXT_URL` (https) and `C1_NEXT_KEY` in the host env. Read at most every 5 minutes. A failed read keeps the last good orders and shows a stale banner. Half-configured = no orders + stale banner. |

The host never reads Square and holds no Square token. The key rides as the
`key` query parameter because Apps Script `doGet` sees only query parameters.
It is never logged or sent to the page.

Only orders dated today or later in America/Chicago are shown.

## C1 read-only link contract

`GET <C1_NEXT_URL>?key=<C1_NEXT_KEY>` returns `200` JSON:

```json
{
  "orders": [
    {
      "id_tail": "hj35YY",
      "fulfill_type": "DELIVERY",
      "event_date": "2026-09-28",
      "event_time": "10:50",
      "ready_time": "10:50",
      "guests": 20,
      "lines": [
        { "item_name": "Fajita Buffet", "variation": "Regular", "modifiers": "1 x Beef, 1 x Corn", "qty": 10 }
      ]
    }
  ]
}
```

- `id_tail`: 4–8 letters/digits (the tail C1 prints, never the full order id).
- `fulfill_type`: `PICKUP` or `DELIVERY`.
- `event_date` `YYYY-MM-DD`, `event_time` / `ready_time` `HH:MM`, Chicago clock.
- `ready_time`, `guests`: may be null. `guests` is C1's CATALOG-type count.
- Any other field is dropped. A 200 without an `orders` list counts as a failed read.

## Privacy fence (23A)

`src/lib/upcoming/fence.ts`. The allow-list above is the guard: there is no
field for a customer name, phone, email, address, or money. On top of it, any
order whose text looks like an email, phone, street address, money, or a
`Name:` label is held back whole; the page shows only how many were held back.
A bare personal name inside an item or modifier cannot be told apart from a
menu word by pattern, so C1 must never put the Square note or customer fields
into these rows (it does not store them today).

`tests/square-next.test.ts` fails the suite if a forbidden field or pattern
reaches the API response or the rendered detail, or if the NEXT code mentions a
Square token or host.

## Imprimir (T4G order in parts)

The detail sheet on `/next` shows **Imprimir** when the host has printing on.
It is never shown on the board strip. A tap asks for a manager code (the same
code gate as the floor board; the token stays in memory and drops on idle),
then `POST /api/upcoming/print` with the order tail only.

The server checks, in order: printing on (else 404), not a staff kiosk token
(403), a manager session (401), a valid tail (400), the tail in the current
C1 snapshot (404), and the order's C1 sheet model (502, refused). Only then
does it run the packing-ticket CLI (`python -m packing_ticket.three_part
--model - --config …`) with the model on stdin, an allow-listed env (no
`BUZZ_*`, no C1 key, no session secret) and a 30 s timeout. The CLI owns the
printer, the station map, the print ledger, the one-print-at-a-time lock and
the five-minute lock after an uncertain send. The response to the tablet is
`status`, `id_tail`, `cambio`, `problems`, `locked_until`; never the model,
the first name, or the child's stderr. Anything but one well-formed JSON line
from the child is **uncertain**.

What the manager sees:

| Result | Text | Button |
|---|---|---|
| ok | Enviado a la impresora morada. Revisa que salieron 4 tickets. | becomes **Reimprimir (CAMBIO)** |
| blocked | No imprimió: sin papel / tapa abierta / apagada / no responde. Arréglala y toca Imprimir otra vez. | stays (nothing was sent) |
| uncertain or locked | Revisa la impresora, no vuelvas a tocar. | gone |
| busy | Ya se está imprimiendo. | stays |

Host settings (all required, all absolute; anything missing keeps printing off):
`T4G_PRINT=on`, `T4G_PRINT_PYTHON`, `T4G_PRINT_DIR` (packing-ticket checkout),
`T4G_PRINT_CONFIG` (its `three_part` config; the printer address lives only
there), `T4G_PRINT_MODEL_SOURCE=fixture`. The fixture model is
`fixtures/square-next/print-models/<tail>.json`. A `sheet` model source waits
on C1 serving the order-sheet model from its read-only link.

Tests: `tests/t4g-imprimir.test.ts` (gates and child contract, child faked);
`tests/t4g-imprimir-real.test.ts` and `playwright.t4g-print.config.ts` run the
real CLI against a fake Epson on 127.0.0.1 when `T4G_PRINT_TEST_DIR` and
`T4G_PRINT_TEST_PYTHON` are set, and skip otherwise.

## Next-version receipt interface (offline)

The Imprimir entry now opens the receipt picker behind manager access, with a
separate all-printer diagnostics page at `/receipts`. See `RECEIPTS-OFFLINE.md`
for the frozen contract and limits. Production has neither an engine dependency
nor a trusted receipt catalog, so operations remain unavailable/held. No tail
is converted into a receipt identity; no printer is contacted by the new route.
