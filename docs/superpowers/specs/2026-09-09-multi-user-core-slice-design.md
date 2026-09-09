# PLUTO-09 Slice 1: Multi-User Core (Gemini-only) — Design

Source requirements: [docs/tasks/09-multi-users.md](../../tasks/09-multi-users.md),
[2026-09-07-multi-user-byok-design.md](2026-09-07-multi-user-byok-design.md)
(the original, unsliced PLUTO-09 design — still the source of truth for
the full three-provider vision; this doc only records the slicing
decision and the handful of adaptations it implies).

## Goal

PLUTO-09 as specced bundles three separate concerns into one task: the
auth/onboarding model, the `expense/service.ts` → Drizzle migration and
`user_id` scoping across every module, and three LLM providers
(Gemini/OpenAI/Anthropic) behind one abstraction. The first two are the
hard, risky part — a schema migration and a mechanical rewrite of every
service function and nearly every test file. The third is comparatively
small and cleanly separable once the abstraction exists.

This slice builds everything in PLUTO-09 **except** the OpenAI and
Anthropic provider implementations. Onboarding still asks "which
provider" and validates against a real provider live, but only `gemini`
is accepted — the app already has exactly one LLM provider today
(`GOOGLE_API_KEY`), so this slice's BYOK is "bring your own Gemini key"
rather than a no-op. Slice 2 adds `src/llm/openai.ts` and
`src/llm/anthropic.ts` and widens the accepted provider set — no changes
to auth, onboarding state, persistence, or any cross-cutting service
signature are expected at that point.

## Why slice here, not elsewhere

The alternative split — ship multi-tenancy first using the existing
global `GOOGLE_API_KEY` for everyone, add real BYOK later — was
rejected: it would mean building `getProviderForUser`/`LLMProvider`
against a single hardcoded key, then reworking every call site a second
time once BYOK lands. Slicing after the abstraction (one provider now,
two more later) touches each call site exactly once.

## What's unchanged from the original design

Everything in [2026-09-07-multi-user-byok-design.md](2026-09-07-multi-user-byok-design.md)'s
scope decisions applies as written: Telegram-only interface, bot-driven
`/setup` with state on the `users` row, AES-256-GCM key encryption via a
required `ENCRYPTION_KEY`, admin-approve-by-chat_id via `ADMIN_CHAT_ID`,
live key validation at `/setup` time, no data backfill (fresh start,
everyone re-registers), and `expense/service.ts` unifying onto Drizzle
alongside `user_id` scoping everywhere. The [data model](2026-09-07-multi-user-byok-design.md#data-model)
is unchanged — the `users.llm_provider` column still exists to hold
whichever provider a user picks; it just only ever holds `'gemini'`
until slice 2.

## Slice-specific decisions

- **`/setup`'s provider-picking step stays in the flow**, even though
  only one answer is valid. Typing `openai` or `anthropic` gets "that
  provider isn't available yet — reply `gemini` for now" rather than
  being silently accepted or the step being skipped. This keeps the
  onboarding state machine identical to the full spec, so slice 2 is
  purely additive (two new files, one widened validation set).
- **`src/llm/provider.ts`** ships now with the full `LLMProvider`
  interface and `getProviderForUser(user)` as specced, but its internal
  switch has one case. **`src/llm/gemini.ts`** ships now;
  `openai.ts`/`anthropic.ts` do not exist until slice 2.
- **`generateSummaryLine` (`src/digest/summary.ts`) keeps its existing
  rule-based fallback** on a failed/timed-out Gemini call — this is
  pre-existing behavior (confirmed in the current code, not documented
  elsewhere) and differs from `classifyUserMessage`/`inferCategory`/
  `parseStatement`, which have no fallback. This slice only threads
  `userId` → `getProviderForUser` through it; the fallback-on-failure
  behavior itself is out of scope to change.
- **`ENCRYPTION_KEY` is unconditionally required** (not gated on
  `TELEGRAM_BOT_TOKEN` like `ADMIN_CHAT_ID` is) — the users table and
  its encrypted key column exist regardless of whether the Telegram bot
  process starts, since the webhook and crons also read user rows.
- **Acceptance criteria carried over as-is** from the task doc — none of
  them name a specific provider (they say "the calling user's own
  stored provider/key," not "Gemini/OpenAI/Anthropic"), so they all
  still hold with a provider set of one. Only the Files-to-Create list
  and the LLM Provider Abstraction section's `GeminiProvider /
  OpenAIProvider / AnthropicProvider` prose shrink for this slice.

## Deferred to slice 2

- `src/llm/openai.ts`, `src/llm/anthropic.ts`.
- Widening `/setup`'s provider validation to accept all three names.
- Any provider-specific model-id research/pinning for OpenAI/Anthropic.
- `src/testing/geminiStub.ts` → provider-agnostic stub rework is only
  needed insofar as this slice's tests require it (stubbing `generateText`
  on the one Gemini provider, or continuing to stub `fetch` underneath
  it — implementation-plan detail, not a design one). A second,
  multi-provider-aware stubbing pass may be needed in slice 2 once real
  OpenAI/Anthropic HTTP calls exist to intercept.

## Everything else

Schema, cross-cutting service changes, cron/webhook changes, and testing
strategy are exactly as described in
[2026-09-07-multi-user-byok-design.md](2026-09-07-multi-user-byok-design.md)
and [docs/tasks/09-multi-users.md](../../tasks/09-multi-users.md) — not
repeated here to avoid the two documents drifting out of sync.
