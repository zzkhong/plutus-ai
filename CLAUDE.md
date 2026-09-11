# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Plutus AI is a personal finance assistant: a Telegram bot (grammy) backed by libSQL/SQLite (Drizzle ORM) that logs expenses, manages budgets, tracks a brokerage/crypto/cash portfolio, splits bills from a receipt photo, sends an AI-powered daily digest, and accepts auto-logged Apple Pay transactions via an iOS Shortcuts webhook. The module build-out plan is in [docs/tasks/](docs/tasks/) (01 foundation → 10 portfolio market digest, all implemented). There is no PRD file in the repo — `doc/pluto-ai-prd.md` was deleted in commit `f6531e4` and never re-added; don't link to it.

**Production runs on Vercel + Turso, free.** The same code also runs as one long-running Node process for local development. See [Runtime modes](#runtime-modes) and the diagrams in [docs/architecture.md](docs/architecture.md). [SETUP.md](SETUP.md) is the user-facing setup and deployment guide.

**Pluto AI is multi-user with bring-your-own-key.** There is no global LLM key and no shared webhook secret. Each user registers through the bot with `/setup`, supplies their own Gemini API key (encrypted at rest with AES-256-GCM under `ENCRYPTION_KEY`), and gets their own `webhook_api_key`. Every service function takes a leading `userId` and scopes its queries to that user.

Current build state: tasks 01–10 are implemented and tested. The one thing outstanding is PLUTO-09 slice 2 — `src/llm/openai.ts` and `src/llm/anthropic.ts`, plus widening `/setup`'s accepted provider names. That is purely additive: implement `LLMProvider` twice and add two cases to `getProviderForUser`. Verify against `buildAssistantReply` in [src/bot/ai.ts](src/bot/ai.ts) before trusting a stale claim here — this file has been wrong about intent wiring before.

`npm test`, `npm run typecheck`, and `npm run lint` are all currently clean. Keep them that way.

## Commands

```bash
npm run dev               # standalone process with hot reload (tsx src/standalone.ts)
npm run build             # tsc -p tsconfig.build.json -> dist/, then copies db migrations into dist/
npm run start             # run the compiled standalone process (dist/standalone.js)
npm run vercel-build      # what Vercel runs: typecheck, then migrate DATABASE_URL (skipped on previews)
npm run typecheck         # tsc --noEmit over everything, test files included
npm run lint              # eslint src --ext .ts
npm test                  # node's built-in test runner over the files wired into package.json
npm run db:generate       # drizzle-kit: write a migration for schema.ts changes
npm run db:migrate        # apply migrations to DATABASE_URL
npm run telegram:webhook -- set <https-url> | info | delete
```

`npm run build` uses [tsconfig.build.json](tsconfig.build.json), which excludes `*.test.ts` and `src/testing/` so tests don't land in `dist/`; use `npm run typecheck` to check test files. The build's second step ([scripts/copy-migrations.js](scripts/copy-migrations.js)) copies `src/db/migrations/` into `dist/` because drizzle's migrator reads the `.sql` files at runtime relative to `__dirname`. That only matters for the compiled standalone process — on Vercel, migrations run from source during the build.

There is no test-file globbing — `npm test` runs a fixed list of `*.test.ts` files via `npx tsx --test`. **New test files must be added explicitly to the `test` script in [package.json](package.json) or they won't run.**

```bash
npx tsx --test src/expense/expense.test.ts
npx tsx --test --test-name-pattern="undoLastTransaction" src/expense/expense.test.ts
```

### Test conventions that matter

**Set `process.env.DATABASE_URL` before anything imports `src/config` or `src/db`.** TypeScript hoists every `require` above the module body, so a *static* `import` of a module that transitively reaches `src/db` opens whatever `DATABASE_URL` resolved to at import time — usually the real `./data/pluto.db`. Every test file sets `DATABASE_URL` (a bare path like `./data/test-x.db` is fine; config normalizes it to `file:`) and pulls in application modules with **dynamic** `await import(...)` inside `before`/test bodies. [src/split/state.test.ts](src/split/state.test.ts) shows the pattern for a file that wants module-level bindings (assign them in `before`).

**`runMigrations()` is async — always `await` it.** The standard preamble is `await runMigrations()` → `createUser(chatId)` → `setProvider(id, 'gemini')` → `completeSetup(id, encrypt('fake-key'), true)` (the `true` is `isAdmin`, which lands the user straight on `'approved'`). Anything reaching a service or an LLM call site needs that user row, because `getProviderForUser` resolves the provider off it.

**No test hits the network by default.** Gemini calls go through the `@google/generative-ai` SDK, whose `generateContent()` resolves `fetch` at call time — so stubbing `global.fetch` is a real interception point. [src/testing/geminiStub.ts](src/testing/geminiStub.ts) (`stubGeminiCategorization()`) returns deterministic categories for any test reaching `inferCategory`. The one exception is [src/bot/ai.test.ts](src/bot/ai.test.ts)'s live test, gated behind `RUN_LIVE_AI_TESTS=1` and reading `process.env.GOOGLE_API_KEY` directly.

**Don't write tests that depend on foreign-key enforcement, and don't monkey-patch module exports.** FKs aren't enforced (see [Persistence](#persistence)), and tsx defines CJS exports as getters so `(mod as any).fn = fake` throws. To exercise a failure path, inject the dependency — e.g. `createApplePayHandler(bot, { logExpense: failingFake })`, or `createWebhookApp(null, { jobs, telegram, waitUntil, ... })` for the Telegram and cron routes.

## Architecture

### Runtime modes

| | Vercel (production) | Standalone (`npm run dev` / `npm start`) |
|---|---|---|
| Entrypoint | [src/app.ts](src/app.ts) default-exports the Hono app | [src/standalone.ts](src/standalone.ts) |
| Telegram | Telegram POSTs updates to `/api/telegram` | `startPolling()` long-polls |
| Daily jobs | Vercel Cron → `/api/cron/recurring`, `/api/cron/digest` ([vercel.json](vercel.json)) | node-cron (`startRecurringScheduler`, `startDigestScheduler`) |
| Database | Turso `libsql://` | `file:` SQLite |
| Migrations | `vercel-build` | on startup |

Both modes build the bot with `createBot()` ([src/bot/index.ts](src/bot/index.ts)) and the HTTP app with `createWebhookApp()` ([src/webhook/index.ts](src/webhook/index.ts)); only the delivery mechanism differs.

- **Vercel entry detection.** Vercel's zero-config Hono support looks for `app`/`index`/`server` files at the root and in `src/`. `src/app.ts` must stay the only such file that imports `hono` — that's why the long-running entry is `src/standalone.ts`, not `src/index.ts`. Don't add a `src/index.ts` or `src/server.ts`.
- **Vercel region.** `vercel.json` pins `hnd1` (Tokyo) to sit next to the Turso database in `aws-ap-northeast-1` — Turso has no Singapore location, and a request makes several DB round trips.
- **Nothing may live in process memory across requests on Vercel** — consecutive updates can hit different instances. That's why `/split` state is in the database. The price-fetcher cache is in memory on purpose; losing it just means refetching.
- **`startPolling()` refuses to start while a webhook is registered.** grammy's `start()` calls `deleteWebhook`, so long-polling locally with the production token would silently cut production off from Telegram. Local development uses a separate bot.

### Persistence

One Drizzle database handle over **libSQL**: [src/db/client.ts](src/db/client.ts) (`db`, `getDb()`, `getClient()`, type `Database`). The same `@libsql/client` speaks to a local SQLite file (`file:` URLs — dev and tests) and to Turso (`libsql://` URLs — production), so every query runs unchanged against either. `db` is fully typed (`LibSQLDatabase<typeof schema>`) — keep it that way; it's what catches a missing `await`. The canonical schema is [src/db/schema.ts](src/db/schema.ts).

- **Every query is async.** There's no synchronous driver any more. For multi-statement atomicity use `db.batch([...])` — it runs as one transaction on both a file and Turso (see `replaceHoldingsForBroker`, `reject`, `removeBudget`). Prefer it over `db.transaction()`, which is an interactive transaction (more round trips over HTTP).
- **Foreign keys are not enforced.** SQLite only enforces them per connection, and Turso's remote sessions aren't pinned to one. The schema's `ON DELETE CASCADE` is documentation, not behaviour: `reject()` deletes a user's transactions, budgets, alerts, holdings, recurring charges and split session explicitly, and `removeBudget()` deletes its alert rows. Any new child table must be added to `reject()`.
- **Migrations** live in `src/db/migrations/` and are generated with `npm run db:generate` (drizzle-kit, `dialect: 'turso'` in [drizzle.config.ts](drizzle.config.ts)). The history was **squashed into a single `0000_baseline` migration** when moving to Turso — no production database existed yet, and the old chain included a `PRAGMA` and `NOT NULL`-without-default `ALTER`s that fail on populated tables. [src/db/migrate.ts](src/db/migrate.ts) runs in `vercel-build`, on standalone startup, and via `npm run db:migrate`; it **skips when `VERCEL_ENV=preview`** so a preview branch can't migrate production, and imports the client lazily so a preview build doesn't need the full config. Read generated SQL before deploying: a new `NOT NULL` column needs a default, and a rename can be generated as drop-and-recreate.
- All monetary amounts are **integer cents**, never floats. `amount_sgd` is the SGD-normalized value used for summaries/budgets regardless of the original currency.

### Users, auth, and the LLM provider

[src/users/](src/users/) owns the `users` table: `createUser`, `setProvider`, `restartOnboarding`, `completeSetup`, `approve`, `reject`, `findByChatId`, `findByWebhookKey`, `findById`, `listApproved` ([service.ts](src/users/service.ts)), plus AES-256-GCM `encrypt`/`decrypt` ([crypto.ts](src/users/crypto.ts)).

A user moves `onboarding` → `pending_approval` → `approved`. `completeSetup` auto-approves when `isAdmin` (the `ADMIN_CHAT_ID` bootstrap) and also when the user already had an encrypted key — a key *rotation* keeps approval and reuses the existing `webhook_api_key`.

[src/llm/provider.ts](src/llm/provider.ts) defines `LLMProvider` (`generateText`, `generateGroundedText`) and `getProviderForUser(user)`. `generateGroundedText` returns `{ text, grounded }` and **must not throw just because a provider has no web-search tool** — it falls back to an ungrounded call and reports `grounded: false` so the caller can caveat the answer. [src/llm/gemini.ts](src/llm/gemini.ts) is the only implementation. **Every LLM call site goes through `getProviderForUser` — never construct a provider from a global key.** The model id is pinned (`gemini-3.6-flash`); if classification starts failing, check `GET /v1beta/models`. The default timeout is 15s because this model's reasoning overhead runs close to 5s.

### Inbound HTTP routes

[src/webhook/index.ts](src/webhook/index.ts) builds the one Hono app. **Every route that does something checks a secret, and refuses (503) if its secret isn't configured** rather than running unauthenticated — compare with [src/utils/secure-compare.ts](src/utils/secure-compare.ts)'s `safeEqual`, not `===`.

| Route | Auth | Notes |
|---|---|---|
| `GET /api/health` | none | |
| `POST /api/telegram` | `X-Telegram-Bot-Api-Secret-Token` = `TELEGRAM_WEBHOOK_SECRET` | [routes/telegram.ts](src/webhook/routes/telegram.ts). Without the check, a forged update could impersonate the admin and `/approve` anyone. |
| `POST /api/apple-pay` | per-user `x-api-key` → `findByWebhookKey`, must be `approved` | [auth.ts](src/webhook/auth.ts): 401 unknown key, 403 unapproved. Logs against that user, confirms on *their* chat. |
| `GET /api/cron/recurring`, `/api/cron/digest` | `Authorization: Bearer CRON_SECRET` (Vercel sends it) | [routes/cron.ts](src/webhook/routes/cron.ts) |

The Telegram route **initializes the bot once per instance** (`bot.init()`, memoized; a failure is forgotten and answered with 500 so Telegram retries), then **acknowledges with 200 immediately and processes the update via `waitUntil`** from `@vercel/functions` (a no-op outside Vercel). Replies that call Gemini can take 15–30s; holding Telegram's request open that long risks a timeout and redelivery, i.e. a duplicate expense.

### Request flow (Telegram)

`authMiddleware` ([src/bot/middleware/auth.ts](src/bot/middleware/auth.ts)) resolves `ctx.chat.id` to a `users` row and attaches it as `ctx.user`. Unregistered and `pending_approval` chats get a canned reply unless the message is `/setup` or `/help`. Command handlers start with `if (!ctx.user) return;` and pass `ctx.user.id` down.

**Handler registration order matters.** grammy runs handlers in registration order and the `message:text` handler consumes every text message without calling `next()`, so every `bot.command(...)` must be registered above it.

The `message:text` handler checks `ctx.user.status === 'onboarding'` first (→ `handleSetupTextMessage`), then `await getSplitState(ctx.chat.id)` (→ `handleSplitTextMessage` — an active split bypasses classification entirely), then classifies. Free text is classified by [src/bot/ai.ts](src/bot/ai.ts) (`classifyUserMessage(userId, text)`) into a `BotIntent` ([src/bot/types.ts](src/bot/types.ts)), and `buildAssistantReply`'s `switch` calls a real service for every intent:

| Intent | Action |
|---|---|
| `budget` | `setBudget`/`removeBudget` in [src/budget/service.ts](src/budget/service.ts) |
| `correction` | `correctLastTransaction` |
| `holdings` | `addHolding`/`removeHolding` in [src/portfolio/service.ts](src/portfolio/service.ts) |
| `expense` | `logExpense` (`source: 'text'`); category comes from `logExpense`'s own categorization |
| `query` | `getSpendingSummary` for `today`/`week`/`month` (default `month`), formatted by `formatSpendingSummary` |
| `recurring` | `createRecurring`, or `removeRecurring` (merchant match via `listRecurring`) for a cancellation |

**Gemini-first by design, deliberately with no rule-based fallback** (see [docs/tasks/02-telegram-bot.md](docs/tasks/02-telegram-bot.md)): if the LLM call fails, `classifyUserMessage` returns `{ intent: 'unknown', serviceError: true }` and the user gets `formatUserFriendlyError()`. Do not reintroduce regex/keyword intent matching — it was tried and removed.

Voice notes ([src/bot/handlers/voice.ts](src/bot/handlers/voice.ts)) are transcribed by the user's provider as multimodal `inlineData`, then routed exactly like typed text (active split first), with the reply prefixed `Heard: "<transcript>"` and `source: 'voice'`. Claude has no audio input, so slice 2's BYOK would need a transcription fallback that PLUTO-09's spec doesn't cover.

`/split` ([src/bot/commands/split.ts](src/bot/commands/split.ts)) is a stateful flow backed by [src/split/](src/split/). Its state lives in the **`split_sessions` table** ([src/split/state.ts](src/split/state.ts), all functions async), keyed by chat, **expiring after 2 hours idle** (`SPLIT_SESSION_TTL_MS`, enforced on read) — while a split is active it captures every text message, so a forgotten one mustn't hijack the chat forever.

### Expense engine internals

[src/expense/service.ts](src/expense/service.ts): `logExpense(userId, data)` resolves currency ([currency-resolver.ts](src/expense/currency-resolver.ts) — explicit > card mapping > merchant/note regex > SGD), infers category (`inferCategory(userId, ...)` in [categorizer.ts](src/expense/categorizer.ts) — the user's provider, returns `'Others'` on failure), converts to SGD cents via `toSGD` (hardcoded `EXCHANGE_RATES` in [src/config/currencies.ts](src/config/currencies.ts)), and inserts.

- `correctLastTransaction`/`undoLastTransaction` only ever touch that user's single most-recent transaction.
- `exportCSV(userId, year)` builds the CSV **in memory** and returns `{ year, filename, content, rowCount }`; `/export` sends it as a Telegram document. Nothing writes to disk (Vercel's filesystem is read-only).
- `fireRecurringForToday(userId)` is **idempotent within a day**: rows it logs carry `recurring_id`, and it skips any template already logged since the start of today. Vercel Cron can deliver twice, and the standalone process runs it at startup and at midnight.

### Portfolio tracker

[src/portfolio/](src/portfolio/): `service.ts` (holdings CRUD, `userId`-scoped; `addHolding`/`removeHolding` only touch manual rows where `broker IS NULL`, `addHolding` throws `StatementHoldingConflictError` rather than double-count a symbol a statement already holds, and `removeHolding` returns the rows removed so the bot can say why nothing was; `replaceHoldingsForBroker` replaces one broker's rows for one user in a single `batch`), `statement-parser.ts` (`parseStatement(userId, pdf)` — the user's provider reads an IBKR/Moomoo PDF into strict JSON with symbols as exchange codes, never names, since that's what pricing looks up; throws `StatementParseError`, no fallback), `price-fetcher/` (Yahoo Finance for stocks — US tickers as-is, SGX/Bursa by exchange code plus `.SI`/`.KL`, with `symbol-map.ts` only for overrides; the quote is valued in Yahoo's own currency and requests send a User-Agent because Yahoo 429s without one — and CoinGecko for crypto via the checked `COINGECKO_IDS` table, where an unlisted coin is deliberately unpriced rather than looked up by name, since tickers collide; in-memory TTL cache), `calculator.ts` (pure net worth/allocation math), and `advice.ts` (`generatePortfolioAdvice` — see digest). PDF uploads are handled end-to-end by [src/bot/handlers/document.ts](src/bot/handlers/document.ts) with no confirmation step. The extraction prompt is still unvalidated against real IBKR/Moomoo PDFs.

### Budget and digest modules

- [src/budget/](src/budget/) — `setBudget`/`removeBudget`/`listBudgets`/`findBudgetByCategory`, `getBudgetStatus(userId)` (spend-vs-limit with days left), and `checkAlerts(userId, transaction)` — called from the recurring job to push a message the first time a category crosses 80%/100% (deduped by `budget_alerts`).
- [src/digest/](src/digest/) — `buildDigestMessage(userId)` = `collectDigestData(userId)` + `generateSummaryLine(userId, data)` + `formatDigestMessage`. Each section is `settle()`-wrapped so one failure degrades only that section. `generateSummaryLine` **keeps a rule-based fallback** (deliberate, unlike other LLM call sites). The portfolio section runs `getPortfolioSummary` → `generatePortfolioAdvice` ([src/portfolio/advice.ts](src/portfolio/advice.ts)), which hands the model the *already-computed* prices and SGD values and never asks it to produce a number; no holdings → a friendly empty state without an LLM call. `/digest` builds it on demand for the caller.

### Scheduled jobs

`triggerRecurringNow(bot)` ([src/scheduler/recurring.ts](src/scheduler/recurring.ts)) and `triggerDigestNow(bot)` ([src/digest/index.ts](src/digest/index.ts)) each loop `listApproved()`, isolate per-user failures, and send proactively via `bot.api.sendMessage(user.telegram_chat_id, ...)`. They're triggered by:

- **Vercel Cron** — [vercel.json](vercel.json) schedules are **UTC**: `0 14 * * *` → digest at 22:00 SGT, `0 16 * * *` → recurring at 00:00 SGT. On Hobby a job fires once a day at some point within the scheduled hour. If `APP_TIMEZONE` changes, change these too.
- **node-cron** in the standalone process — `0 22 * * *` and `0 0 * * *` in `APP_TIMEZONE`, plus a startup catch-up run of the recurring job.

### Config and types

- [src/config/env.ts](src/config/env.ts): Zod-validated, loaded once at import; throws on invalid config. **`ENCRYPTION_KEY` is the only unconditionally required var.** `ADMIN_CHAT_ID` is required when `TELEGRAM_BOT_TOKEN` is set; `DATABASE_AUTH_TOKEN` is required when `DATABASE_URL` is `libsql://`. `DATABASE_URL` defaults to `file:./data/pluto.db` and a bare path is normalized to `file:`. `TELEGRAM_WEBHOOK_SECRET` (Telegram's `[A-Za-z0-9_-]` alphabet) and `CRON_SECRET` are only needed on Vercel. Empty values in `.env` count as unset. `GOOGLE_API_KEY`, `WEBHOOK_API_KEY`, and `TELEGRAM_AUTHORIZED_CHAT_ID` were **removed** — don't reintroduce global secrets.
- **Timezone:** Vercel reserves `TZ` (always UTC), so env.ts sets `process.env.TZ = config.APP_TIMEZONE` (default `Asia/Singapore`) at load, before any date math. All "today"/month/day-of-month logic uses local time and depends on this.
- [src/config/currencies.ts](src/config/currencies.ts): the `Currency` union, `DEFAULT_CARD_CURRENCY_MAP`, and hardcoded `EXCHANGE_RATES` — **units of each currency per 1 SGD**, which `toSGD` divides by. Update by hand when they drift, keeping every entry in that direction; [currencies.test.ts](src/config/currencies.test.ts) fails on an inverted rate (MYR once was, making RM 45 count as S$150).
- [src/types/](src/types/): shared domain types. Add new domain types here first.

### Data files

Locally, `./data/pluto.db` is the development database (gitignored, created on demand). Each test file uses its own `./data/test-*.db` and deletes it at start, which keeps the suite parallel-safe. [src/scripts/telegram-webhook.ts](src/scripts/telegram-webhook.ts) (`npm run telegram:webhook`) registers the production webhook; it deliberately doesn't load `src/config`.
