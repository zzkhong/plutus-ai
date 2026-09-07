# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Plutus AI is a personal finance assistant: a Telegram bot (Grammy) backed by SQLite (better-sqlite3 + Drizzle ORM) that logs expenses, manages budgets, tracks a brokerage/crypto/cash portfolio, splits bills from a receipt photo, sends an AI-powered daily digest, and accepts auto-logged Apple Pay transactions via an iOS Shortcuts webhook. Message understanding is Gemini-first with no rule-based fallback — `GOOGLE_API_KEY` is a required env var. The module build-out plan is in [docs/tasks/](docs/tasks/) (01 foundation → 08 expense split, implemented; 09–10 are specced but not yet implemented — multi-user/BYOK and a market-advice digest layer). The product spec (`doc/pluto-ai-prd.md`) was deleted in commit `f6531e4` ("chore: move md files") while the rest of `doc/` was renamed to `docs/`, and was never re-added — there is currently no PRD file in the repo; don't link to it.

Current build state: foundation, the Telegram bot shell, the expense engine, the budget system, the portfolio tracker, the expense split calculator, the daily digest, and the iOS Shortcuts webhook (tasks 01–08) are implemented and tested. **One thing is still a stub**: wiring the free-text "expense" intent to `logExpense` (Gemini classifies it correctly, but `buildAssistantReply` only acknowledges it — see below). Everything else described as "not yet wired" or "stub" in older notes has since been built; verify against the code before trusting a stale claim here — this file has been wrong about the portfolio tracker's status before.

## Commands

```bash
npm run dev      # run with tsx (hot reload, no build step)
npm run build     # tsc -> dist/
npm run start     # run compiled dist/index.js
npm run lint      # eslint src --ext .ts
npm run format    # prettier --write src/**/*.ts
npm test          # node's built-in test runner over the *.test.ts files wired into package.json
```

There is no test-file globbing — `npm test` runs a fixed list of `*.test.ts` files (currently `src/bot/ai.test.ts`, `src/expense/expense.test.ts`, `src/budget/service.test.ts`, `src/budget/progress.test.ts`, `src/budget/alerts.test.ts`, `src/scheduler/recurring.test.ts`, `src/digest/digest.test.ts`, `src/webhook/webhook.test.ts`, `src/portfolio/service.test.ts`, `src/portfolio/price-fetcher/crypto.test.ts`, `src/portfolio/price-fetcher/stocks.test.ts`, `src/portfolio/price-fetcher/index.test.ts`, `src/portfolio/calculator.test.ts`, `src/portfolio/statement-parser.test.ts`, `src/bot/handlers/document.test.ts`) via `npx tsx --test`. To run a single test file or filter by name:

```bash
npx tsx --test src/expense/expense.test.ts
npx tsx --test --test-name-pattern="undoLastTransaction" src/expense/expense.test.ts
```

New test files must be added explicitly to the `test` script in [package.json](package.json) or they won't run.

**No test hits the real Gemini API by default.** Every Gemini call site exercised by the default test run is stubbed: [src/bot/ai.test.ts](src/bot/ai.test.ts) stubs `global.fetch` directly; [src/expense/expense.test.ts](src/expense/expense.test.ts) and [src/webhook/webhook.test.ts](src/webhook/webhook.test.ts) stub it via the shared helper [src/testing/geminiStub.ts](src/testing/geminiStub.ts) (`stubGeminiCategorization()`), which keyword-matches the merchant/note text embedded in the categorization prompt to return a deterministic category so `inferCategory` never makes a network call. This matters because both `classifyUserMessage` ([src/bot/ai.ts](src/bot/ai.ts)) and `inferCategory` ([src/expense/categorizer.ts](src/expense/categorizer.ts)) go through the `@google/generative-ai` SDK, whose `generateContent()` resolves `fetch` at call time — stubbing `global.fetch` is a real interception point, not a no-op, and it's the pattern to reuse for any new test that reaches either of those functions (directly or via `logExpense`/`correctLastTransaction`). The one exception is [src/bot/ai.test.ts](src/bot/ai.test.ts)'s "real Gemini call" test, gated behind `RUN_LIVE_AI_TESTS=1` — opt in only when you deliberately want to burn real API quota (the free tier is rate-limited, e.g. 20 requests/day) and have network access.

`npm run lint` runs cleanly config-wise (the repo uses a flat [eslint.config.mjs](eslint.config.mjs); the old `.eslintrc.js` is gone) but currently reports genuine pre-existing findings — mostly `@typescript-eslint/no-explicit-any` in test files, plus one unused import in `src/index.ts`. Don't treat a non-zero exit as a config problem; it's lint debt.

## Architecture

### Two independent SQLite access paths — read before touching persistence

There are **two separate places that open the SQLite database and create tables**, and they are not unified:

- [src/db/client.ts](src/db/client.ts) — a Drizzle-wrapped singleton (`db`, `getDb()`), opened once at import time, used for the canonical schema ([src/db/schema.ts](src/db/schema.ts)).
- [src/expense/service.ts](src/expense/service.ts) — every exported function (`logExpense`, `getSpendingSummary`, `exportCSV`, etc.) opens its **own** raw `better-sqlite3` connection via `getSQLiteDb()`, runs `CREATE TABLE IF NOT EXISTS` for `transactions`/`recurring_transactions` again, executes hand-written SQL, and closes the connection before returning. It does not go through Drizzle or `src/db/`.

Both point at the same file (`config.DATABASE_URL`) and the table definitions are kept in sync by hand — if you change a column in [src/db/schema.ts](src/db/schema.ts), update the raw `CREATE TABLE`/`INSERT`/`SELECT` strings in [src/expense/service.ts](src/expense/service.ts) too. When adding new persistence code, prefer extending the expense module's raw-SQL pattern for consistency with existing expense/recurring code, or ask whether to migrate that module onto Drizzle — don't silently mix a third approach in.

### Request flow (Telegram)

`src/index.ts` → constructs `PlutoBot` ([src/bot/index.ts](src/bot/index.ts)) if `TELEGRAM_BOT_TOKEN` is set → middleware chain (`authMiddleware` single-chat allowlist, then `errorHandlerMiddleware`) → command handlers (`/portfolio`, `/today`, `/month`, `/budget`, `/export`, `/undo`, `/digest`, `/help`) in [src/bot/commands/](src/bot/commands/), or free-text/voice messages routed through [src/bot/handlers/text.ts](src/bot/handlers/text.ts) / `voice.ts`. `src/index.ts` also starts the recurring-transaction cron ([src/scheduler/recurring.ts](src/scheduler/recurring.ts)), the digest cron ([src/digest/](src/digest/), 10pm Asia/Singapore, no catch-up on a missed run), and the iOS Shortcuts webhook server ([src/webhook/](src/webhook/), Hono, its own port via `config.PORT`) — all three run independently of whether the Telegram bot itself started.

Free text is classified by [src/bot/ai.ts](src/bot/ai.ts) (`classifyUserMessage` → Gemini) into a `BotIntent` (`expense | query | budget | correction | recurring | help | unknown`), then `buildAssistantReply` generates a reply per intent — real, not canned, for `budget` (calls `setBudget`/`removeBudget` in [src/budget/service.ts](src/budget/service.ts)) and `correction` (calls `correctLastTransaction`). **Pluto AI is Gemini-first by design, deliberately with no rule-based fallback** (see [docs/tasks/02-telegram-bot.md](docs/tasks/02-telegram-bot.md)): `GOOGLE_API_KEY` is a required env var — startup fails without it (see [src/config/env.ts](src/config/env.ts)) — and if the Gemini call itself fails at runtime (timeout, network error, unparseable JSON), `classifyUserMessage` returns `{ intent: 'unknown', serviceError: true }` rather than guessing via keywords; `buildAssistantReply` turns that into the generic `formatUserFriendlyError()` message. Do not reintroduce regex/keyword intent matching as a substitute for a real Gemini response — that was tried and explicitly removed. The model id is pinned explicitly (`gemini-3.6-flash` as of 2026-08) rather than an alias, since Gemini model ids get deprecated over time; if classification starts failing, check `GET /v1beta/models` against the configured key. The classification call has a generous timeout (15s) because this model's reasoning overhead routinely runs close to 5s for the classification prompt.

**The `expense` intent is the one classification branch still not wired to the expense engine** — Gemini correctly extracts amount/merchant/category, but `buildAssistantReply`'s `expense` case only returns an acknowledgement string; it never calls `logExpense`. Transactions actually get persisted through three paths only: the `/today`/`/month`/`/export`/`/undo` slash commands reading/writing via [src/expense/service.ts](src/expense/service.ts), the recurring-transaction cron firing due entries, and the iOS Shortcuts webhook (`POST /api/apple-pay`, see [src/webhook/routes/apple-pay.ts](src/webhook/routes/apple-pay.ts) and [docs/setup/ios-shortcut-setup.md](docs/setup/ios-shortcut-setup.md)).

`/portfolio` and `/budget` are both real: `/portfolio` calls `getPortfolioSummary` ([src/portfolio/index.ts](src/portfolio/index.ts), see below), `/budget` calls `getBudgetStatus` ([src/budget/progress.ts](src/budget/progress.ts)).

`/split` ([src/bot/commands/split.ts](src/bot/commands/split.ts)) starts a separate, stateful bill-splitting flow backed by [src/split/](src/split/) (`extraction.ts` for Gemini-vision receipt line-item extraction, `assignment.ts` for matching free text to items, `calculator.ts` for the even/itemized math, `state.ts` for the in-memory `Map<chatId, SplitState>`); `/cancel` aborts it at any stage. `src/bot/index.ts` also registers a `message:photo` handler now, meaningful only while a split is awaiting a receipt photo. Critically, `src/bot/index.ts`'s `message:text` handler checks `getSplitState(ctx.chat.id)` first and, whenever a split is active, routes the message to `handleSplitTextMessage` instead of `classifyUserMessage` — an active split fully bypasses the Gemini-first classification path described above until it finishes or is cancelled.

### Expense engine internals

[src/expense/service.ts](src/expense/service.ts) is the core: `logExpense` resolves currency (`resolveCurrency` in [currency-resolver.ts](src/expense/currency-resolver.ts) — explicit currency > card-name mapping > regex on merchant/note > SGD default), infers category (`inferCategory` in [categorizer.ts](src/expense/categorizer.ts) — calls Gemini directly with merchant/note/amount, no local regex fallback; returns `'Others'` if the call fails or returns something unparseable), converts to SGD cents via `toSGD` ([src/config/currencies.ts](src/config/currencies.ts), hardcoded `EXCHANGE_RATES`), and inserts. All monetary amounts are stored as **integer cents**, never floats/decimals. `amount_sgd` is always the SGD-normalized value used for summaries/budgets regardless of the original currency.

Because `inferCategory` hits Gemini on every call, any test that reaches `logExpense` or `correctLastTransaction` (which also calls `inferCategory` when correcting the `category` field) must stub `global.fetch` via [src/testing/geminiStub.ts](src/testing/geminiStub.ts) — see the Commands section above.

`correctLastTransaction(field, value)` only ever mutates the single most-recent transaction — there's no way to target an arbitrary past transaction.

### Portfolio tracker

[src/portfolio/](src/portfolio/) is fully implemented: `service.ts` (Drizzle CRUD against the `holdings` table — `addHolding`/`removeHolding` only ever touch manually-entered rows where `broker IS NULL`, `replaceHoldingsForBroker` wholesale-replaces one broker's rows in a transaction), `statement-parser.ts` (`parseStatement` sends a PDF to Gemini multimodal, detects IBKR vs Moomoo, and extracts positions as strict JSON — throws `StatementParseError` on any failure, no rule-based fallback, same degrade-don't-guess convention as `classifyUserMessage`), `price-fetcher/` (Yahoo Finance chart API for US/MY/SG stocks — MY/SG symbols resolved via a hand-maintained `symbol-map.ts` table, unmapped symbols degrade to "unavailable" — and CoinGecko for crypto, both with an in-memory TTL cache, no DB-backed price cache), and `calculator.ts` (pure net worth/allocation math). `src/bot/handlers/document.ts` handles PDF uploads (`message:document` in [src/bot/index.ts](src/bot/index.ts)) end-to-end: parse → `replaceHoldingsForBroker` → reply with the new net worth, no confirmation step. Crypto/cash holdings are entered via chat, not statement upload. See [docs/superpowers/specs/2026-08-31-portfolio-tracker-design.md](docs/superpowers/specs/2026-08-31-portfolio-tracker-design.md) for the full design and its one known gap (the extraction prompt is unvalidated against real IBKR/Moomoo PDFs).

### Budget, digest, and webhook modules

- [src/budget/](src/budget/) — `setBudget`/`removeBudget`/`listBudgets`/`findBudgetByCategory` ([service.ts](src/budget/service.ts)), `getBudgetStatus` ([progress.ts](src/budget/progress.ts), spend-vs-limit per category with days-left-in-month), and `checkAlerts` ([alerts.ts](src/budget/alerts.ts)) — called from the recurring-transaction cron to push a Telegram message the first time a category crosses a threshold.
- [src/digest/](src/digest/) — `buildDigestMessage` composes an AI-written nightly summary from `collectDigestData` (aggregator), `generateSummaryLine` (Gemini), and `formatDigestMessage`; `startDigestScheduler` runs it at 10pm Asia/Singapore via node-cron, `/digest` triggers it on demand. The digest's `portfolio` section is still a stub (`{ error: 'not yet implemented' }` in `collectDigestData`) — task 10 fills it in with LLM-generated market-advice on top of the already-implemented portfolio tracker.
- [src/webhook/](src/webhook/) — a standalone Hono app (`createWebhookApp`) exposing `GET /api/health` and `POST /api/apple-pay` (guarded by `apiKeyAuthMiddleware` checking `WEBHOOK_API_KEY` against the `x-api-key` header). Meant to be exposed via a Cloudflare quick tunnel for the iOS Shortcuts automation described in [docs/setup/ios-shortcut-setup.md](docs/setup/ios-shortcut-setup.md); the webhook server does not start if `WEBHOOK_API_KEY` is unset.

### Config and types

- [src/config/env.ts](src/config/env.ts): Zod-validated env vars, loaded once at import time; throws on invalid config. `GOOGLE_API_KEY` is **required** — startup fails without it, since there is no fallback classification path. `TELEGRAM_BOT_TOKEN` and `TELEGRAM_AUTHORIZED_CHAT_ID` are optional — their absence changes runtime behavior (bot doesn't start / auth is open to any chat) rather than failing startup.
- [src/config/currencies.ts](src/config/currencies.ts): supported `Currency` union (`SGD | MYR | USD | BTC | ETH | BETH`), `DEFAULT_CARD_CURRENCY_MAP`, and hardcoded `EXCHANGE_RATES` (not fetched live — update manually if rates drift).
- [src/types/](src/types/): shared domain types (`transaction.ts`, `portfolio.ts`, `budget.ts`), re-exported from `src/types/index.ts`. Add new domain types here first, before wiring up config/db/logic, per the existing task breakdown.

### Data files

`./data/pluto.db` is the runtime database (gitignored, created on demand). Each test file points `DATABASE_URL` at its own `./data/test-*.db` file (e.g. `test-plutus.db`, `test-ai-budget.db`, `test-webhook.db`, `test-scheduler-alerts.db`, `test-digest.db`, `test-budget-{service,progress,alerts}.db`) and deletes/recreates it on each run — this is what lets the whole suite run in parallel-safe isolation without a shared fixture db. CSV exports from `/export` land in `./data/exports/`.
