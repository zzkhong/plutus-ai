# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Plutus AI is a personal finance assistant: a Telegram bot (Grammy) backed by SQLite (better-sqlite3 + Drizzle ORM) that logs expenses, manages budgets, tracks a brokerage/crypto/cash portfolio, splits bills from a receipt photo, sends an AI-powered daily digest, and accepts auto-logged Apple Pay transactions via an iOS Shortcuts webhook. The module build-out plan is in [docs/tasks/](docs/tasks/) (01 foundation → 10 portfolio market digest, all implemented). The product spec (`doc/pluto-ai-prd.md`) was deleted in commit `f6531e4` ("chore: move md files") while the rest of `doc/` was renamed to `docs/`, and was never re-added — there is currently no PRD file in the repo; don't link to it.

**Pluto AI is multi-user with bring-your-own-key.** There is no global LLM key and no shared webhook secret. Each user registers through the bot with `/setup`, supplies their own Gemini API key (encrypted at rest with AES-256-GCM under `ENCRYPTION_KEY`), and gets their own `webhook_api_key`. Every service function takes a leading `userId` and scopes its queries to that user. [SETUP.md](SETUP.md) is the user-facing setup guide.

Current build state: tasks 01–10 are implemented and tested — foundation, the Telegram bot shell, the expense engine, the budget system, the portfolio tracker, the expense split calculator, the daily digest, the iOS Shortcuts webhook, the multi-user/BYOK core slice, and the portfolio market digest. The one thing still outstanding is PLUTO-09 slice 2 — `src/llm/openai.ts` and `src/llm/anthropic.ts`, plus widening `/setup`'s accepted provider names. That is purely additive: implement `LLMProvider` twice and add two cases to `getProviderForUser`. All free-text intents are wired to real actions, and voice notes are transcribed via Gemini — see the breakdowns below. Verify against `buildAssistantReply` in [src/bot/ai.ts](src/bot/ai.ts) and `handleVoiceMessage` in [src/bot/handlers/voice.ts](src/bot/handlers/voice.ts) before trusting a stale claim here — this file has been wrong about intent wiring and the portfolio tracker's status before.

`npm test`, `npm run typecheck`, and `npm run lint` are all currently clean. Keep them that way.

## Commands

```bash
npm run dev        # run with tsx (hot reload, no build step)
npm run build      # tsc -p tsconfig.build.json -> dist/, then copies db migrations into dist/
npm run start      # run compiled dist/index.js
npm run typecheck  # tsc --noEmit over everything, test files included
npm run lint       # eslint src --ext .ts
npm run format     # prettier --write src/**/*.ts
npm test           # node's built-in test runner over the *.test.ts files wired into package.json
```

`npm run build` uses [tsconfig.build.json](tsconfig.build.json), which excludes `*.test.ts` and `src/testing/` so tests don't land in `dist/`. Typechecking still covers them via the base [tsconfig.json](tsconfig.json) — use `npm run typecheck`, not `npm run build`, to check test files.

The build's second step ([scripts/copy-migrations.js](scripts/copy-migrations.js)) copies `src/db/migrations/` into `dist/db/migrations/`. `tsc` only emits `.ts` files, but drizzle's migrator reads the `.sql` files and `meta/_journal.json` at runtime relative to `__dirname` — without that copy, `npm run build && npm run start` dies on the first `migrate()` call.

There is no test-file globbing — `npm test` runs a fixed list of `*.test.ts` files via `npx tsx --test`. **New test files must be added explicitly to the `test` script in [package.json](package.json) or they won't run.** To run a single test file or filter by name:

```bash
npx tsx --test src/expense/expense.test.ts
npx tsx --test --test-name-pattern="undoLastTransaction" src/expense/expense.test.ts
```

### Test conventions that matter

**Set `process.env.DATABASE_URL` before anything imports `src/config` or `src/db`.** TypeScript hoists every `require` above the module body, so a *static* `import` of a module that transitively reaches `src/db` will open and migrate whatever `DATABASE_URL` resolved to at import time — usually the real `./data/pluto.db`. Every test file therefore sets `DATABASE_URL` at the top and pulls in application modules with **dynamic** `await import(...)` inside `before`/test bodies. [src/portfolio/statement-parser.test.ts](src/portfolio/statement-parser.test.ts) shows the pattern for a file that needs module-level bindings anyway (assign them in `before`).

**Most tests need a real approved user row.** Anything reaching a service function or an LLM call site needs a `users` row with a decryptable key, because `getProviderForUser` resolves the provider off that row. The standard preamble is `runMigrations()` → `createUser(chatId)` → `setProvider(id, 'gemini')` → `completeSetup(id, encrypt('fake-key'), true)` (the `true` is `isAdmin`, which lands the user straight on `'approved'`).

**No test hits a real LLM API by default.** Gemini calls go through the `@google/generative-ai` SDK, whose `generateContent()` resolves `fetch` at call time — so stubbing `global.fetch` is a real interception point. [src/bot/ai.test.ts](src/bot/ai.test.ts) stubs it directly; [src/expense/expense.test.ts](src/expense/expense.test.ts) and [src/webhook/webhook.test.ts](src/webhook/webhook.test.ts) use the shared helper [src/testing/geminiStub.ts](src/testing/geminiStub.ts) (`stubGeminiCategorization()`), which keyword-matches the merchant/note text in the categorization prompt to return a deterministic category so `inferCategory` never makes a network call. Reuse that for any new test reaching `inferCategory` (directly or via `logExpense`/`correctLastTransaction`). The one exception is [src/bot/ai.test.ts](src/bot/ai.test.ts)'s "real Gemini call" test, gated behind `RUN_LIVE_AI_TESTS=1` and reading `process.env.GOOGLE_API_KEY` directly (that var is no longer part of the validated config — it's just a convenient place to park a real key) — opt in only when you deliberately want to burn real API quota.

**Module-export monkey-patching does not work.** tsx defines CJS exports as getters, so `(mod as any).someExport = fake` throws `Cannot set property ... which has only a getter`. To exercise a failure path, cause a genuine one instead — e.g. the webhook's 500-path test drives the handler with a `userId` that isn't in `users`, tripping the `transactions.user_id` foreign key.

## Architecture

### Persistence

Everything goes through **one** Drizzle-wrapped SQLite singleton: [src/db/client.ts](src/db/client.ts) (`db`, `getDb()`), opened once at import time against `config.DATABASE_URL`, with `PRAGMA foreign_keys = ON` and drizzle migrations run automatically on startup. The canonical schema is [src/db/schema.ts](src/db/schema.ts); migrations live in `src/db/migrations/` and are generated with `npm run db:generate`.

(Historical note: `src/expense/service.ts` used to open its own raw `better-sqlite3` connection and hand-maintain duplicate `CREATE TABLE` strings. That was migrated onto Drizzle in commit `6642b4a` — there is no longer a second access path, and no hand-syncing of table definitions. Don't reintroduce one.)

All monetary amounts are stored as **integer cents**, never floats/decimals. `amount_sgd` is always the SGD-normalized value used for summaries/budgets regardless of the original currency.

Every domain table (`transactions`, `holdings`, `budgets`, `budget_alerts`, `recurring_transactions`) has a `user_id` FK to `users.id` with `onDelete: 'cascade'` — rejecting a user deletes their data.

### Users, auth, and the LLM provider

[src/users/](src/users/) owns the `users` table: `createUser`, `setProvider`, `restartOnboarding`, `completeSetup`, `approve`, `reject`, `findByChatId`, `findByWebhookKey`, `findById`, `listApproved` ([service.ts](src/users/service.ts)), plus AES-256-GCM `encrypt`/`decrypt` ([crypto.ts](src/users/crypto.ts)) keyed off the required `ENCRYPTION_KEY`.

A user moves `onboarding` → `pending_approval` → `approved`. `completeSetup` auto-approves when `isAdmin` (the `ADMIN_CHAT_ID` bootstrap) and also when the user already had an encrypted key — i.e. a key *rotation* keeps approval and reuses the existing `webhook_api_key` rather than minting a new one.

[src/llm/provider.ts](src/llm/provider.ts) defines the `LLMProvider` interface and `getProviderForUser(user)`, which decrypts that user's key and returns a provider. The interface has two methods: `generateText` and `generateGroundedText`. The latter returns `{ text, grounded }` and **must not throw just because a provider has no web-search tool** — it falls back to an ungrounded call and reports `grounded: false` so the caller can caveat the answer (see `generatePortfolioAdvice`). [src/llm/gemini.ts](src/llm/gemini.ts) is the only implementation today (`llm_provider` only ever holds `'gemini'`); slice 2 of PLUTO-09 adds `openai.ts`/`anthropic.ts` and widens `/setup`'s accepted set, with no changes to auth, persistence, or any call-site signature. **Every LLM call site goes through `getProviderForUser` — never construct a provider from a global key.**

The Gemini model id is pinned explicitly (`gemini-3.6-flash`) rather than an alias, since Gemini model ids get deprecated; if classification starts failing, check `GET /v1beta/models` against the configured key. The default timeout is 15s because this model's reasoning overhead routinely runs close to 5s for the classification prompt.

### Request flow (Telegram)

`src/index.ts` → constructs `PlutoBot` ([src/bot/index.ts](src/bot/index.ts)) if `TELEGRAM_BOT_TOKEN` is set → middleware chain (`authMiddleware`, then `errorHandlerMiddleware`) → command handlers in [src/bot/commands/](src/bot/commands/), or free-text messages routed through [src/bot/handlers/text.ts](src/bot/handlers/text.ts). `src/index.ts` also starts the recurring-transaction cron ([src/scheduler/recurring.ts](src/scheduler/recurring.ts)), the digest cron ([src/digest/](src/digest/), 10pm Asia/Singapore, no catch-up on a missed run), and the iOS Shortcuts webhook server ([src/webhook/](src/webhook/), Hono, its own port via `config.PORT`) — all three run independently of whether the Telegram bot itself started.

`authMiddleware` ([src/bot/middleware/auth.ts](src/bot/middleware/auth.ts)) resolves `ctx.chat.id` to a `users` row and attaches it as `ctx.user` ([BotContext](src/bot/context.ts)). Unregistered and `pending_approval` chats are turned away with a canned reply unless the message is `/setup` or `/help`. Command handlers therefore start with `if (!ctx.user) return;` and pass `ctx.user.id` down.

**Handler registration order matters.** grammy runs handlers in registration order, and the `message:text` handler consumes every text message without calling `next()` — so any `bot.command(...)` must be registered *before* it. `/start` was previously registered after and never fired.

Free text is classified by [src/bot/ai.ts](src/bot/ai.ts) (`classifyUserMessage(userId, text)` → that user's provider) into a `BotIntent` ([src/bot/types.ts](src/bot/types.ts): `expense | query | budget | correction | recurring | holdings | help | unknown`), then `buildAssistantReply`'s `switch` on intent calls a real service for every intent:

| Intent | Wired to a real action? |
|---|---|
| `budget` | Yes — calls `setBudget`/`removeBudget` in [src/budget/service.ts](src/budget/service.ts) |
| `correction` | Yes — calls `correctLastTransaction` |
| `holdings` | Yes — calls `addHolding`/`removeHolding` in [src/portfolio/service.ts](src/portfolio/service.ts) |
| `expense` | Yes — calls `logExpense` (`source: 'text'`); category comes from `logExpense`'s own Gemini categorization, not the classifier's guess |
| `query` | Yes — calls `getSpendingSummary` for the extracted period (`today`/`week`/`month`, defaults to `month`) and formats it via `formatSpendingSummary` in [src/bot/formatter/messages.ts](src/bot/formatter/messages.ts), the same helper `/today` and `/month` use |
| `recurring` | Yes — calls `createRecurring`, or `removeRecurring` (matched by merchant name, case-insensitive, via `listRecurring`) when the message reads as a cancellation |

**Gemini-first by design, deliberately with no rule-based fallback** (see [docs/tasks/02-telegram-bot.md](docs/tasks/02-telegram-bot.md)): if the LLM call fails at runtime (timeout, network error, unparseable JSON), `classifyUserMessage` returns `{ intent: 'unknown', serviceError: true }` rather than guessing via keywords, and `buildAssistantReply` turns that into the generic `formatUserFriendlyError()` message. Do not reintroduce regex/keyword intent matching as a substitute for a real response — that was tried and explicitly removed. The recurring intent needs a `dayOfMonth` extracted field (1-31) that the other intents don't use — it's called out explicitly in the classification prompt's system instruction alongside the other `extracted` fields.

Voice notes are transcribed via [src/bot/handlers/voice.ts](src/bot/handlers/voice.ts)'s `transcribeVoice`, which sends the audio to the user's provider as multimodal `inlineData` (same pattern as `parseStatement`, just audio instead of a PDF) — no dedicated speech-to-text provider, consistent with the no-fallback rule. `handleVoiceMessage` then routes the transcript exactly like typed text: an active `/split` (`getSplitState`) gets it via `handleSplitTextMessage`, otherwise it goes through `classifyUserMessage`/`buildAssistantReply`, and the reply is prefixed `Heard: "<transcript>"` so the user can see what was understood. Expenses logged this way carry `source: 'voice'` — `buildAssistantReply` takes an optional trailing `source: ExpenseSource` argument (defaults to `'text'`) threaded only into its `expense` case's `logExpense` call. A transcription failure or empty transcript degrades to a friendly reply rather than guessing. Note that when slice 2 adds more providers, Claude has no audio-input support, so BYOK would need a transcription fallback (e.g. always transcribe via Gemini/Whisper regardless of the user's chosen provider) that PLUTO-09's spec doesn't currently cover.

New transactions get created through four paths: the recurring-transaction cron firing due entries, the iOS Shortcuts webhook (`POST /api/apple-pay`), `/split`'s "log your share" confirmation step (`source: 'split'`), and free-text/voice `expense` messages. A free-text `recurring` message doesn't create a transaction directly — it creates/removes a `recurring_transactions` template row that the cron fires (or stops firing) later. `/today`/`/month`/`/export`/`/undo` only read or delete.

`/split` ([src/bot/commands/split.ts](src/bot/commands/split.ts)) starts a separate, stateful bill-splitting flow backed by [src/split/](src/split/) (`extraction.ts` for LLM-vision receipt line-item extraction, `assignment.ts` for matching free text to items, `calculator.ts` for the even/itemized math, `state.ts` for the in-memory `Map<chatId, SplitState>`); `/cancel` aborts it at any stage. `src/bot/index.ts` registers a `message:photo` handler that is meaningful only while a split is awaiting a receipt photo. Critically, the `message:text` handler checks `ctx.user.status === 'onboarding'` first (routing to `handleSetupTextMessage`), then `getSplitState(ctx.chat.id)` — an active split fully bypasses the classification path until it finishes or is cancelled.

### Expense engine internals

[src/expense/service.ts](src/expense/service.ts) is the core: `logExpense(userId, data)` resolves currency (`resolveCurrency` in [currency-resolver.ts](src/expense/currency-resolver.ts) — explicit currency > card-name mapping > regex on merchant/note > SGD default), infers category (`inferCategory(userId, ...)` in [categorizer.ts](src/expense/categorizer.ts) — calls the user's provider with merchant/note/amount, no local regex fallback; returns `'Others'` if the call fails or returns something unparseable), converts to SGD cents via `toSGD` ([src/config/currencies.ts](src/config/currencies.ts), hardcoded `EXCHANGE_RATES`), and inserts.

`correctLastTransaction(userId, field, value)` only ever mutates that user's single most-recent transaction — there's no way to target an arbitrary past transaction. Same for `undoLastTransaction`.

### Portfolio tracker

[src/portfolio/](src/portfolio/): `service.ts` (Drizzle CRUD against `holdings`, all `userId`-scoped — `addHolding`/`removeHolding` only ever touch manually-entered rows where `broker IS NULL`, `replaceHoldingsForBroker` wholesale-replaces one broker's rows for one user in a transaction), `statement-parser.ts` (`parseStatement(userId, pdfBuffer)` sends a PDF to the user's provider, detects IBKR vs Moomoo, extracts positions as strict JSON — throws `StatementParseError` on any failure, no rule-based fallback), `price-fetcher/` (Yahoo Finance chart API for US/MY/SG stocks — MY/SG symbols resolved via a hand-maintained `symbol-map.ts` table, unmapped symbols degrade to "unavailable" — and CoinGecko for crypto, both with an in-memory TTL cache, no DB-backed price cache), and `calculator.ts` (pure net worth/allocation math). `src/bot/handlers/document.ts` handles PDF uploads end-to-end: parse → `replaceHoldingsForBroker` → reply with the new net worth, no confirmation step. Crypto/cash holdings are entered via chat, not statement upload. See [docs/superpowers/specs/2026-08-31-portfolio-tracker-design.md](docs/superpowers/specs/2026-08-31-portfolio-tracker-design.md) for the full design and its one known gap (the extraction prompt is unvalidated against real IBKR/Moomoo PDFs).

### Budget, digest, and webhook modules

- [src/budget/](src/budget/) — `setBudget`/`removeBudget`/`listBudgets`/`findBudgetByCategory` ([service.ts](src/budget/service.ts)), `getBudgetStatus(userId)` ([progress.ts](src/budget/progress.ts), spend-vs-limit per category with days-left-in-month), and `checkAlerts(userId, transaction)` ([alerts.ts](src/budget/alerts.ts)) — called from the recurring-transaction cron to push a Telegram message the first time a category crosses a threshold.
- [src/digest/](src/digest/) — `buildDigestMessage(userId)` composes an AI-written nightly summary from `collectDigestData(userId)` (aggregator), `generateSummaryLine(userId, data)`, and `formatDigestMessage`; `startDigestScheduler` runs it at 10pm Asia/Singapore via node-cron, `/digest` triggers it on demand for the calling user. `triggerDigestNow` loops `listApproved()` and sends each user their own digest on their own `telegram_chat_id`, logging and continuing past any one user's failure. Unlike the other LLM call sites, `generateSummaryLine` **keeps a rule-based fallback** on a failed call (pre-existing, deliberate). The `portfolio` section calls `getPortfolioSummary` and then `generatePortfolioAdvice` ([src/portfolio/advice.ts](src/portfolio/advice.ts)), which hands the model the *already-computed* prices and SGD values and asks only what today's news means for them — it never asks the model to produce a number. A user with no holdings gets a friendly empty state without spending an LLM call.
- [src/webhook/](src/webhook/) — a standalone Hono app (`createWebhookApp`) exposing `GET /api/health` and `POST /api/apple-pay`. `apiKeyAuthMiddleware` ([auth.ts](src/webhook/auth.ts)) resolves the `x-api-key` header to its owning user via `findByWebhookKey` and requires `status === 'approved'` — 401 for an unknown key, 403 for a real-but-unapproved one — then sets `user` on the Hono context (typed via `WebhookEnv` in [types.ts](src/webhook/types.ts)). The route logs against that user and sends the confirmation to *their* chat. The server always starts; there is no global secret to gate it. Meant to be exposed via a Cloudflare quick tunnel — see [docs/setup/ios-shortcut-setup.md](docs/setup/ios-shortcut-setup.md).

### Crons

Both crons iterate approved users rather than running once globally, and both isolate per-user failures: [src/scheduler/recurring.ts](src/scheduler/recurring.ts) (`fireForAllApprovedUsers`, daily at 00:00, plus a startup catch-up via `triggerRecurringNow`) and [src/digest/index.ts](src/digest/index.ts) (`triggerDigestNow`, daily at 22:00 Asia/Singapore, no catch-up). Both send proactively via `bot.api.sendMessage(user.telegram_chat_id, ...)`, not `ctx.reply`. Follow that shape for any new cron.

### Config and types

- [src/config/env.ts](src/config/env.ts): Zod-validated env vars, loaded once at import time; throws on invalid config. **`ENCRYPTION_KEY` is the only unconditionally required var** (64 hex chars). `ADMIN_CHAT_ID` is required whenever `TELEGRAM_BOT_TOKEN` is set — without a designated admin, nobody could ever be approved. `TELEGRAM_BOT_TOKEN` is optional; its absence just means the bot doesn't start. `GOOGLE_API_KEY`, `WEBHOOK_API_KEY`, and `TELEGRAM_AUTHORIZED_CHAT_ID` were **removed** — don't reintroduce global secrets.
- [src/config/currencies.ts](src/config/currencies.ts): supported `Currency` union (`SGD | MYR | USD | BTC | ETH | BETH`), `DEFAULT_CARD_CURRENCY_MAP`, and hardcoded `EXCHANGE_RATES` (not fetched live — update manually if rates drift).
- [src/types/](src/types/): shared domain types (`transaction.ts`, `portfolio.ts`, `budget.ts`), re-exported from `src/types/index.ts`. Add new domain types here first, before wiring up config/db/logic, per the existing task breakdown.

### Data files

`./data/pluto.db` is the runtime database (gitignored, created on demand). Each test file points `DATABASE_URL` at its own `./data/test-*.db` file and deletes/recreates it on each run — this is what lets the suite run in parallel-safe isolation without a shared fixture db. CSV exports from `/export` land in `./data/exports/`, which is gitignored (they contain real per-user financial data).
