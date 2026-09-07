# PLUTO-08: Expense Split

| Field | Value |
|-------|-------|
| Module | Expense Split (bill-splitting calculator) |
| Priority | P2 |
| Dependencies | PLUTO-03 (Expense Engine) — reuses `logExpense`/`inferCategory`. **Not** dependent on PLUTO-09 — other participants are free-text names, not Plutus accounts. |
| Estimated effort | Medium |

---

## Description

A chat-driven bill-splitting calculator. `/split`, then a photo of a
receipt, then either a headcount ("split evenly among 3") or free text
saying who had what ("Alice had the burger, I had the salad, split
drinks between us"). The bot extracts line items from the photo,
computes each person's share (tax/service charge/tip applied
proportionally), and shows the full breakdown. The other people in a
split are not Plutus users — they're just names for the calculation.
Whether the requester's own share gets logged as a real expense is
asked explicitly each time, not automatic, since the bill may already
be auto-logged via the Apple Pay webhook (PLUTO-07) if that's how it
was paid — logging it again from `/split` too would double-count it.

---

## Acceptance Criteria

- [ ] `/split` starts the flow and asks for a receipt photo; any other
      message while idle is unaffected (no implicit trigger on a bare
      photo)
- [ ] The photo is sent to the user's LLM for vision extraction:
      merchant (if visible), line items (name + price), subtotal, tax/
      service charge/tip, and total, returned as strict JSON
- [ ] Extraction failure (blurry photo, not a receipt, unparseable
      response) replies asking for a resend — no rule-based fallback,
      same convention as `statement-parser.ts`
- [ ] After extraction, the bot asks: split evenly, or who had what
- [ ] **Even split**: a headcount divides the total (items + tax/tip)
      evenly across that many people
- [ ] **Itemized split**: free text naming people/items is matched by
      the LLM against the extracted line items; each named person's
      tax/service/tip share is proportional to their share of the
      pre-tax subtotal, not split evenly regardless of order size
- [ ] The bot identifies which share is the requester's own from their
      wording ("I", "me"); if it can't tell confidently, it asks
      before showing the breakdown
- [ ] The bot always shows the full per-person breakdown, then asks
      "Log your share of $X as an expense?" — a hint notes to skip
      this if it's already been auto-logged some other way (e.g. Apple
      Pay)
- [ ] **Yes** → the requester's own share only is logged via the
      existing `logExpense` (`source: 'split'`); other people's shares
      are never logged anywhere, since they may not be Plutus users
- [ ] **No** → nothing is logged; the flow just ends
- [ ] `/cancel` aborts the flow at any stage
- [ ] A stale/abandoned flow (bot restarted mid-flow) is not resumed —
      the user just runs `/split` again

---

## Flow & State

State lives in-memory (`Map<chatId, SplitState>`), not persisted. A
bot restart mid-flow loses it — the user just runs `/split` again —
which is an acceptable tradeoff for a handful of messages exchanged in
close succession, unlike PLUTO-09's onboarding (days-long admin-approval
wait), which is why that flow's state lives on the `users` row instead.

```
awaiting_photo
  → (photo received, extraction ok) → awaiting_instructions
  → (extraction fails) → stays awaiting_photo, error reply
awaiting_instructions
  → (headcount) → compute even split → awaiting_log_confirmation
  → (free text) → LLM matches names/items → compute itemized split
      → if requester's share is ambiguous → ask, stay awaiting_instructions
      → else → awaiting_log_confirmation
awaiting_log_confirmation
  → (yes) → logExpense(requester's share) → done, state cleared
  → (no) → done, state cleared
any state → /cancel → done, state cleared
```

---

## Calculation

Given extracted `items: { name, price }[]`, `taxAndTip: number`
(sum of tax/service charge/tip, however itemized on the receipt),
`total: number`:

- **Even split**: `perPerson = total / headcount`.
- **Itemized split**: for each named person, `itemSubtotal = sum of
  their assigned items' prices`; `theirShareOfTaxAndTip = taxAndTip *
  (itemSubtotal / sum of all items' prices)`; `theirTotal =
  itemSubtotal + theirShareOfTaxAndTip`. Unassigned items (e.g.
  "split drinks between us") are divided evenly among the people
  sharing them before being folded into each person's `itemSubtotal`.

---

## Files to Create / Modify

```
src/
├── split/
│   ├── types.ts               # ExtractedReceipt, SplitResult, SplitState
│   ├── extraction.ts          # extractReceipt(photoBuffer) -> ExtractedReceipt
│   ├── calculator.ts          # pure: calculateEvenSplit, calculateItemizedSplit
│   └── state.ts                # in-memory Map<chatId, SplitState>
├── bot/
│   ├── commands/split.ts       # /split, /cancel
│   ├── handlers/photo.ts       # message:photo — new, only meaningful mid-flow
│   └── index.ts                # wire /split, /cancel, message:photo
```

`extraction.ts` follows the same Gemini-multimodal, degrade-don't-guess
pattern as `src/portfolio/statement-parser.ts` — an
`ExtractionError` on any failure, no fallback parser. `calculator.ts`
is pure (no I/O), following the same convention as
`src/portfolio/calculator.ts`.

---

## Testing

- `calculator.test.ts`: even split divides total correctly; itemized
  split applies tax/tip proportionally to item subtotal, not evenly;
  shared/unassigned items split evenly among their sharers before
  proportional tax/tip; rounding doesn't lose or invent cents across
  all shares.
- `extraction.test.ts`: stubs the provider call (pattern from
  `geminiStub.ts`) for a valid receipt JSON; malformed/unparseable
  response throws `ExtractionError`.
- Flow/state tests: `/split` → photo → even-split headcount → yes/no
  logging branches; `/split` → photo → itemized free text → ambiguous
  self-identification triggers a clarifying question instead of
  guessing; `/cancel` clears state at any stage; a message sent with
  no active split state falls through to normal text/photo handling
  untouched.
- Confirms only the requester's own share ever reaches `logExpense` —
  other named people's shares never create a transaction.

---

## Out of Scope

- Any persistence of the other participants — they're not Plutus
  users, not stored anywhere beyond the reply message.
- Debt/settlement tracking ("Alice owes Bob $12.50" with a way to mark
  it paid) — explicitly rejected as unnecessary complication; this is
  a calculator, not a ledger.
- Multi-user integration of any kind (see Dependencies above).
- Splitting from a typed/manual item list instead of a photo.
