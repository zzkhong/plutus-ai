# PLUTO-10: Portfolio Market Digest

| Field | Value |
|-------|-------|
| Module | Daily Market Digest (advice layer on top of the existing Portfolio Tracker) |
| Priority | P1 |
| Dependencies | PLUTO-09 (Multi-User Platform & BYOK) — advice generation uses each user's own LLM provider; PLUTO-04 (Portfolio Tracker, already implemented) — this task reads its data, doesn't rebuild it; PLUTO-06 (Daily Digest) — extends its existing `portfolio` slot |
| Estimated effort | Medium |

---

## Description

**Correction from an earlier draft of this doc**: the portfolio
tracker is *not* a stub. PLUTO-04 is fully implemented — `src/portfolio/`
has a working statement-PDF import (Gemini multimodal, IBKR/Moomoo
detection, per-broker wholesale replace), real price fetching (Yahoo
Finance for US/MY/SG stocks, CoinGecko for crypto, in-memory TTL
cache), and net worth/allocation math, all wired into `/portfolio` and
a `message:document` handler. CLAUDE.md's claim that `/portfolio`
"returns a hardcoded placeholder string" is stale and is being
corrected alongside this doc. See
[docs/superpowers/specs/2026-08-31-portfolio-tracker-design.md](../superpowers/specs/2026-08-31-portfolio-tracker-design.md)
for that module's actual design.

This task does two things, both additive to the existing module:

1. **Multi-user scoping** of `src/portfolio/` — covered by PLUTO-09's
   cross-cutting changes (`user_id` on `holdings`, `parseStatement`
   using the calling user's own LLM provider instead of the global
   `GOOGLE_API_KEY`). Not re-specified here; see PLUTO-09.
2. **New**: fills in the daily digest's already-stubbed `portfolio`
   section (`{ error: 'not yet implemented' }` in
   `src/digest/aggregator.ts`) with an LLM-generated market take —
   portfolio-level impact of the day's market moves, specific holdings
   flagged when news materially affects them, and a hold/trim/rebalance
   lean — grounded via the LLM provider's own web search rather than a
   separate news API, and fed the module's *already-computed real
   prices and values* (not asked to guess them).

Existing import behavior (PDF-only, no confirmation step, per-broker
wholesale replace) is intentionally left unchanged — not in scope
here.

---

## Status

**Implemented.** `generatePortfolioAdvice` lives in
[src/portfolio/advice.ts](../../src/portfolio/advice.ts) and is wired into
`collectDigestData` behind the same `settle()` used by every other section.
Grounding is expressed on the provider interface as `generateGroundedText`,
which returns `{ text, grounded }` — Gemini attempts Google Search
grounding and falls back to an ungrounded call, reporting `grounded:false`
so the caller appends the caveat. Slice 2's OpenAI/Anthropic providers only
need to implement that one method.

## Acceptance Criteria

- [x] The nightly digest's portfolio section, for a user with holdings
      on file, shows: an overall portfolio-level take on how today's
      market news affects it, call-outs for specific holdings with
      notable news, and a hold/trim/rebalance lean
- [x] The advice prompt is built from the user's *already-computed*
      `PortfolioSummary` (net worth, allocation, and each holding's
      real fetched price/`change_pct` from `getPortfolioSummary()`) —
      the LLM reasons about news impact on real numbers, it does not
      invent prices
- [x] A user with no holdings on file gets a friendly "send a
      statement to get started" line in that section, not an error
- [x] A failed/timed-out advice generation degrades to a short error
      line for that section only — the rest of the digest still sends
      (same `SectionResult`/`settle()` pattern already used for
      spending/budget/recurring)
- [x] When the user's LLM provider doesn't support web-search/grounding,
      advice still generates from the model's training data with an
      explicit caveat line, rather than skipping the section
- [x] Advice generation is fully scoped per user — user A's digest
      section never reflects user B's holdings, and vice versa

---

## Market Digest Generation

`src/digest/aggregator.ts`'s `collectDigestData()` gains a per-user
call to the existing `getPortfolioSummary()` (already user-scoped
under PLUTO-09) and, when `summary.holdings.length > 0`, calls a new
`generatePortfolioAdvice(userId, summary)` — same `settle()`-wrapped,
degrade-independently pattern as the spending/budget/recurring
sections already use.

`generatePortfolioAdvice` runs through `getProviderForUser` (PLUTO-09)
and asks the provider to use its native web-search/grounding tool if
it has one, so the call covers "what happened in the market today"
grounded against holdings the module already knows the real value and
movement of. Providers differ in grounding support (e.g. Gemini's
Google Search grounding tool vs. OpenAI's/Anthropic's web-search
tools); where a provider's implementation doesn't support grounding,
advice still generates from the model's training data with an
explicit caveat ("based on general knowledge, not live market data")
rather than silently skipping the section.

Prompt inputs, per holding, straight from `EnrichedHolding`: symbol,
name, asset_class, quantity, currency, `value_sgd`, and
`quote.change_pct` when priced (skip/caveat unpriced holdings, same
"price unavailable" treatment `/portfolio` already uses). Output: one
plain-text section — portfolio-level take, then any individual
holdings worth flagging, then a lean.

---

## Files to Create / Modify

```
src/
├── portfolio/
│   └── advice.ts               # new: generatePortfolioAdvice(userId, summary) -> string
├── digest/
│   ├── aggregator.ts            # modify: call getPortfolioSummary + generatePortfolioAdvice per user
│   ├── formatter.ts             # modify: replace formatPortfolioSection's hardcoded error
│   └── types.ts                 # modify: DigestData.portfolio -> SectionResult<string>
```

No changes to `src/portfolio/service.ts`, `statement-parser.ts`,
`price-fetcher/`, `calculator.ts`, or the bot's document-upload/
`/portfolio` command wiring — those already work and are only touched
by PLUTO-09's `user_id`/provider threading, not by this task.

---

## Testing

- `advice.test.ts`: stubs the provider call (same pattern as
  `geminiStub.ts`) to verify the prompt is built from a given
  `PortfolioSummary` and that output is returned as plain text;
  provider-without-grounding path includes the caveat line;
  provider-call failure/timeout throws in a way `settle()` degrades
  cleanly.
- Digest aggregator: holdings present → advice section populated;
  zero holdings → friendly empty-state line, not an error; advice call
  fails/times out → section-level error only, rest of digest
  unaffected.
- Cross-user isolation: user A's digest advice is built only from user
  A's `getPortfolioSummary()`, never user B's.

---

## Out of Scope

- Any change to statement import, price fetching, or replace semantics
  — PLUTO-04's existing behavior stands.
- A dedicated news/market-data API integration — grounding only.
- On-demand `/marketdigest` command — ships folded into the existing
  nightly digest only.
- Validating the statement-extraction prompt against real IBKR/Moomoo
  PDFs — pre-existing known gap from PLUTO-04, unrelated to this task.
