# PLUTO-08: Expense Split — Design

Source requirements: [docs/tasks/08-expense-split.md](../../tasks/08-expense-split.md)

## Goal

A chat-driven bill-splitting calculator: photo of a receipt in,
per-person breakdown out, with the requester's own share optionally
logged as a real expense.

## Scope decisions (resolved during brainstorming)

- **Other participants are not Plutus users.** Splitting between
  people only needs their names for the calculation — nothing is
  stored or logged for them. This was the biggest scope call: an
  earlier assumption that "splitting between multiple people" implied
  multiple Plutus accounts would have made this depend on PLUTO-09;
  it doesn't.
- **Explicit `/split` trigger, not any bare photo.** Photos aren't
  used for anything else today, but requiring the command avoids ever
  mis-triggering a split on a photo sent for an unrelated reason.
- **Itemized assignment is free text, LLM-matched**, not a rigid
  per-item reply format — more natural, and consistent with how the
  rest of the bot already treats chat input (`classifyUserMessage`,
  `inferCategory`).
- **Tax/service charge/tip is split proportionally** to each person's
  item subtotal, not evenly — matches real-world expectation when
  orders are uneven.
- **Logging the requester's own share is asked every time, not
  automatic.** The first design assumed auto-logging was safe; it
  isn't — if the bill was paid via Apple Pay, the webhook (PLUTO-07)
  already auto-logs the full amount, so also logging the calculated
  share from `/split` would double-count the same real-world payment.
  Asking each time reintroduces a *residual* double-count risk if the
  user says yes to something Apple Pay already caught, which was
  accepted as a known tradeoff over the alternative (never logging,
  even when nothing else recorded the expense) — the confirmation
  prompt is worded to remind the user to skip it if already logged.
- **No debt/settlement ledger.** Explicitly rejected as unnecessary
  complication — this shows a breakdown, it doesn't track who owes
  whom or let anyone mark a debt settled.
- **State is in-memory, not DB-persisted**, since a split is a few
  messages exchanged in quick succession — unlike PLUTO-09's
  onboarding, which persists state on the `users` row because
  admin-approval can take real time.

## Design

See the task doc's [Flow & State](../../tasks/08-expense-split.md#flow--state)
and [Calculation](../../tasks/08-expense-split.md#calculation) sections
for the full state machine and split math — not duplicated here.
`src/split/extraction.ts` follows the same Gemini-multimodal,
degrade-don't-guess convention as `src/portfolio/statement-parser.ts`
(an `ExtractionError` on any failure, no fallback parser);
`src/split/calculator.ts` is pure, following the same convention as
`src/portfolio/calculator.ts`.

## Testing

Even vs. itemized split math (including proportional tax/tip and
rounding), extraction failure handling, the full state machine
including ambiguous self-identification and `/cancel`, and a guarantee
that only the requester's own share ever reaches `logExpense`. Full
detail in the task doc's [Testing](../../tasks/08-expense-split.md#testing)
section.

## Out of scope

No persistence of other participants, no debt/settlement tracking, no
multi-user integration, no manual/typed item entry. See the task doc's
[Out of Scope](../../tasks/08-expense-split.md#out-of-scope) section.
