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
