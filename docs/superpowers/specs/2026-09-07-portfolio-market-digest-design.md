# PLUTO-10: Portfolio Market Digest — Design

Source requirements: [docs/tasks/10-portfolio-market-digest.md](../../tasks/10-portfolio-market-digest.md)

## Goal

Fill in the daily digest's already-stubbed `portfolio` section with
LLM-generated market advice: portfolio-level impact of the day's news,
specific holdings flagged when news materially affects them, and a
hold/trim/rebalance lean.

## Scope decisions (resolved during brainstorming)

- **This is not a portfolio-tracker rebuild.** An earlier round of
  this brainstorm assumed `/portfolio` was still the hardcoded
  placeholder CLAUDE.md described and drafted a full statement-import
  redesign (wholesale replace, a Yes/Cancel confirmation step, photo
  support). Checking the actual code (`src/portfolio/`, `git log`)
  showed PLUTO-04 was already fully implemented — real PDF statement
  import via Gemini multimodal, Yahoo Finance/CoinGecko price
  fetching, net worth/allocation math — and CLAUDE.md was stale (now
  corrected). This task was rescoped down to just the new advice layer
  plus the `user_id`/provider threading PLUTO-09 already covers for
  every other module.
- **Existing import behavior is left untouched.** PDF-only, no
  confirmation step, per-broker wholesale replace — all deliberately
  kept as-is rather than layering UX changes onto working code that
  wasn't broken.
- **Advice is grounded via the LLM provider's own web search**, not a
  dedicated news or pricing API — consistent with avoiding a second
  external API/key when the model can search directly. Where a
  provider's `LLMProvider` implementation doesn't support grounding,
  advice still generates from the model's training data with an
  explicit caveat rather than silently skipping the section.
- **The prompt is built from real, already-computed numbers** —
  `getPortfolioSummary()`'s `EnrichedHolding[]` (real fetched prices,
  `change_pct`, `value_sgd`) — not asked to invent current prices
  itself. This was the main win of reconciling with PLUTO-04's
  existing price-fetcher machinery instead of building a
  grounding-only, no-verified-source version from scratch.
- **Folded into the existing 10pm digest**, not a separate schedule or
  on-demand command — the digest's `DigestData.portfolio` slot has
  been sitting at `{ error: 'not yet implemented' }` since PLUTO-06,
  waiting for exactly this.

## Design

See the task doc's [Market Digest Generation](../../tasks/10-portfolio-market-digest.md#market-digest-generation)
and [Files to Create / Modify](../../tasks/10-portfolio-market-digest.md#files-to-create--modify)
sections for the full shape — `generatePortfolioAdvice(userId,
summary)` in a new `src/portfolio/advice.ts`, wired into
`digest/aggregator.ts`'s `settle()` pattern, `digest/formatter.ts`,
and `digest/types.ts`. No other file in `src/portfolio/` changes.

## Testing

Provider-call stubbing, grounding-vs-no-grounding caveat behavior,
digest degrade-on-failure, empty-portfolio empty state, and cross-user
isolation. Full detail in the task doc's
[Testing](../../tasks/10-portfolio-market-digest.md#testing) section.

## Out of scope

No changes to statement import/pricing/replace semantics, no
dedicated news API, no on-demand digest command. See the task doc's
[Out of Scope](../../tasks/10-portfolio-market-digest.md#out-of-scope)
section.
