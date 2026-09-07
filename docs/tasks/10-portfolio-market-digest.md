# PLUTO-10: Portfolio Tracker & Market Digest

| Field | Value |
|-------|-------|
| Module | Portfolio Tracker (real implementation) + Daily Market Digest |
| Priority | P1 |
| Dependencies | PLUTO-09 (Multi-User Platform & BYOK) — holdings are user-scoped and advice uses each user's own LLM provider; PLUTO-06 (Daily Digest) — extends its existing `portfolio` slot |
| Estimated effort | Large |

---

## Description

Makes `/portfolio` real (it's currently a hardcoded placeholder — see
PLUTO-04) via statement import instead of manual entry: a user sends a
PDF or photo of a brokerage/bank statement, the LLM extracts their
holdings, and those replace what's on file. The existing nightly
digest's already-stubbed `portfolio` section (`{ error: 'not yet
implemented' }` in `src/digest/aggregator.ts`) is filled in with an
LLM-generated market take: portfolio-level impact of the day's market
moves, specific holdings flagged when news materially affects them,
and a lean (hold / trim / rebalance) — using the LLM's own web
search/grounding rather than a separate news or pricing API.

Depends on PLUTO-09 because holdings need `user_id` scoping and advice
generation needs to run through each user's own stored LLM
provider/key, both of which only exist once multi-user ships.

---

## Acceptance Criteria

- [ ] Sending a PDF or photo to the bot (no command needed) is treated
      as a statement import: text-extracted (PDF) or passed directly
      as an image (photo) to the user's LLM provider, which returns
      structured holdings (`symbol`, `name`, `asset_class`, `quantity`,
      `currency`, `market`, `cost_basis?`)
- [ ] Bot replies with the parsed holdings and a Yes/Cancel prompt
      before saving anything
- [ ] Confirming **wholesale-replaces** the user's `holdings` rows
      (delete all + insert the extracted set) — the statement is
      treated as the current authoritative snapshot, not a merge
- [ ] Cancelling discards the extraction; nothing is written
- [ ] `/portfolio` shows the user's actual stored holdings (symbol,
      quantity, market, cost basis, and a cost-basis total) instead of
      the placeholder string
- [ ] The nightly digest's portfolio section, for a user with holdings
      on file, shows: an overall portfolio-level take on how today's
      market news affects it, call-outs for individual holdings with
      notable news, and a hold/trim/rebalance lean
- [ ] A user with no holdings on file gets a friendly "send a
      statement to get started" line in that section, not an error
- [ ] A failed/timed-out advice generation degrades to a short error
      line for that section only — the rest of the digest still sends
      (same `SectionResult`/`settle()` pattern already used for
      spending/budget/recurring)
- [ ] Advice generation and holdings are fully scoped per user — user
      A never sees or influences user B's portfolio or digest section

---

## Statement Import Flow

New handlers on `message:document` and `message:photo` (neither exists
today — only `message:text` and `message:voice` are wired in
`src/bot/index.ts`):

1. User sends a PDF or photo.
2. PDF → extract text (e.g. `pdf-parse`) → pass as text to the LLM.
   Photo → pass the image directly to the provider's vision input (no
   text extraction step).
3. Prompt asks for strict JSON: an array of holdings matching the
   existing `Holding` shape (`src/types/portfolio.ts`).
4. Bot replies with the parsed list formatted for review + "Reply
   YES to save or CANCEL to discard."
5. The pending extracted list is held **in-memory**
   (`Map<userId, ExtractedHolding[]>`), not persisted — if the bot
   restarts mid-confirmation, the user just re-sends the file. Chosen
   over a DB-backed pending-state table for simplicity, since this is
   a two-message, seconds-long interaction, unlike the days-long
   admin-approval wait in PLUTO-09's onboarding flow.
6. **YES** → one transaction: delete all `holdings` where
   `user_id = ?`, insert the extracted set with that `user_id`.
   **CANCEL** → drop the in-memory entry, nothing written.

*Flagged for review*: this assumes any PDF/photo sent to the bot is a
statement — there's no `/import` command gate. If false positives turn
out to be a problem in practice (e.g. a user photographs a receipt for
an unrelated reason), this can be tightened to require an explicit
command later.

---

## Market Digest Generation

`src/digest/aggregator.ts`'s `collectDigestData()` gains a holdings
lookup (via the new portfolio service) per user and, when holdings
exist, calls a new `generatePortfolioAdvice(userId, holdings)` — same
`settle()`-wrapped, degrade-independently pattern as the other
sections. This runs through `getProviderForUser` (PLUTO-09), asking
the provider to use its native web-search/grounding tool if it has
one, so the same call covers both "what happened in the market today"
and "what's the current price/performance of these specific holdings"
without a separate news or pricing API/key.

*Flagged for review*: `LLMProvider` implementations differ in
grounding support (e.g. Gemini's Google Search grounding tool vs.
OpenAI's/Anthropic's web-search tools). Where a provider's
implementation doesn't support grounding, advice is still generated
from the model's own training data, with an explicit caveat line
("based on general knowledge, not live market data") rather than
skipping the section — silently ungrounded advice would be
misleading.

Prompt inputs per holding: symbol, name, asset_class, quantity,
currency, market, and cost basis if present (for gain/loss context).
Output: one plain-text section — portfolio-level take, then any
individual holdings worth flagging, then a lean. No numeric valuation
is computed by Plutus itself (there's still no live pricing
integration anywhere in the codebase); if the grounded call surfaces
current prices, that's model output being repeated back, not a value
this app calculates or stores — `/portfolio` and PLUTO-05 budgets keep
using `cost_basis` only.

---

## Files to Create / Modify

```
src/
├── portfolio/
│   ├── service.ts           # listHoldings(userId), replaceHoldings(userId, holdings)
│   ├── extraction.ts        # extractHoldingsFromStatement(userId, file) -> ExtractedHolding[]
│   └── advice.ts             # generatePortfolioAdvice(userId, holdings) -> string
├── bot/
│   ├── handlers/document.ts  # message:document — PDF import
│   ├── handlers/photo.ts     # message:photo — image import
│   └── commands/portfolio.ts # real listing instead of placeholder
├── digest/
│   ├── aggregator.ts         # add holdings lookup + generatePortfolioAdvice call
│   ├── formatter.ts          # replace formatPortfolioSection's hardcoded error
│   └── types.ts              # DigestData.portfolio -> SectionResult<PortfolioAdvice>
└── db/
    └── (holdings table already gains user_id under PLUTO-09 — no separate migration)
```

---

## Testing

- Extraction: fixture PDF text / image → expected structured holdings
  JSON (stub the provider call, same pattern as `geminiStub.ts`).
- Import confirmation state machine: YES commits and wholesale-replaces
  only that user's holdings; CANCEL discards; a second user's holdings
  are untouched by the first user's import.
- `/portfolio` renders stored holdings correctly, including the
  no-holdings-yet case.
- Digest aggregator: holdings present → advice section populated;
  no holdings → friendly empty-state line, not an error; advice call
  fails/times out → section-level error, rest of digest unaffected.
- Cross-user isolation: user A's import/digest never touches user B's
  holdings or advice.

---

## Out of Scope

- Live price/valuation data computed or stored by Plutus itself — any
  price mentioned in advice is grounded-model output, not a stored or
  verified value.
- CSV statement import (PDF + photo only, per current scope).
- Manual holdings entry commands (`/addholding` etc.) — import is the
  only way holdings get created for now.
- A dedicated news/market-data API integration — grounding only.
- On-demand `/marketdigest` command — this ships folded into the
  existing nightly digest only.
