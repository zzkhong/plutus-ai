# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Plutus AI is a personal finance assistant: a Telegram bot (grammy) backed by libSQL/SQLite (Drizzle ORM). **Its core is expense tracking and budgeting**: expenses logged from chat, voice notes, receipt photos and Apple Pay (via an iOS Shortcuts webhook); per-category and overall monthly budgets with threshold and pace alerts; income and savings rate; and a month-end review. Around that it tracks a brokerage/crypto/cash portfolio, splits bills from a receipt photo, and sends an AI-written nightly digest. There is no PRD file in the repo; don't link to one.

**Production runs on Vercel + Turso, free.** The same code also runs as one long-running Node process for local development. See [Runtime modes](#runtime-modes) and the diagrams in [docs/architecture.md](docs/architecture.md). [SETUP.md](SETUP.md) is the user-facing setup and deployment guide.

**Plutus AI is multi-user with bring-your-own-key.** There is no global LLM key and no shared webhook secret. Each user registers through the bot with `/setup`, supplies their own Gemini API key (encrypted at rest with AES-256-GCM under `ENCRYPTION_KEY`), and gets their own `webhook_api_key`. Every service function takes a leading `userId` and scopes its queries to that user.

Gemini is the only LLM provider implemented. Adding OpenAI or Anthropic is additive: implement `LLMProvider`, add a case to `getProviderForUser`, and widen `/setup`'s accepted provider names. Claude has no audio input, so voice notes would then need a transcription fallback. Verify claims here against `buildAssistantReply` in [src/bot/ai.ts](src/bot/ai.ts) before trusting them — this file has been wrong about intent wiring before.

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

**Set `process.env.DATABASE_URL` before anything imports `src/config` or `src/db`.** TypeScript hoists every `require` above the module body, so a *static* `import` of a module that transitively reaches `src/db` opens whatever `DATABASE_URL` resolved to at import time — usually the real `./data/pluto.db`. Every test file sets `DATABASE_URL` (a bare path like `./data/test-x.db` is fine; config normalizes it to `file:`) and pulls in application modules with **dynamic** `await import(...)` inside `before`/test bodies. Pure modules are safe to import statically — [src/utils/dates.ts](src/utils/dates.ts) and [src/bot/formatter/messages.ts](src/bot/formatter/messages.ts) are, and must stay free of anything that reaches the database. [src/split/state.test.ts](src/split/state.test.ts) shows the pattern for a file that wants module-level bindings (assign them in `before`).

**`runMigrations()` is async — always `await` it.** The standard preamble is `await runMigrations()` → `createUser(chatId)` → `setProvider(id, 'gemini')` → `completeSetup(id, encrypt('fake-key'), true)` (the `true` is `isAdmin`, which lands the user straight on `'approved'`). Anything reaching a service or an LLM call site needs that user row, because `getProviderForUser` resolves the provider off it. Tests that care about exact totals create their own user, so other tests' rows in the same file can't shift the numbers.

**No test hits the network by default.** Gemini calls go through the `@google/generative-ai` SDK, whose `generateContent()` resolves `fetch` at call time — so stubbing `global.fetch` is a real interception point. [src/testing/geminiStub.ts](src/testing/geminiStub.ts) (`stubGeminiCategorization()`) returns deterministic categories for any test reaching `inferCategory`. Passing `categoryHint` to `logExpense` avoids the categorizer entirely. [src/expense/editing.test.ts](src/expense/editing.test.ts) wraps the stub to count LLM calls. The one exception is [src/bot/ai.test.ts](src/bot/ai.test.ts)'s live test, gated behind `RUN_LIVE_AI_TESTS=1` and reading `process.env.GOOGLE_API_KEY` directly.

**The test suite never calls exchangerate-api.** The `test` script passes `--import ./src/testing/offline-env.cjs`, which blanks `EXCHANGE_RATE_API_KEY` in every test process before dotenv loads — dotenv never overrides a variable that's already set, and config treats empty as unset — so conversions use `FALLBACK_EXCHANGE_RATES`. [src/fx/rates.test.ts](src/fx/rates.test.ts) passes `apiKey` explicitly and stubs `fetch`.

**Date-dependent code takes an injectable `now`.** `getSpendingSummary`, `getBudgetStatus`, `checkAlerts`, `classifyUserMessage`, `buildAssistantReply` (`options.now`), `handleMonthCommand`, `buildMonthReview`/`handleReviewCommand` and `handleReceiptPhoto` accept one. Tests pin a date (`new Date(2026, 5, 20, 15)`) and log with `spentAt` inside that month, rather than depending on today — pace alerts in particular change with the day of the month.

**Don't write tests that depend on foreign-key enforcement, and don't monkey-patch module exports.** FKs aren't enforced (see [Persistence](#persistence)), and tsx defines CJS exports as getters so `(mod as any).fn = fake` throws. To exercise a failure path, inject the dependency — e.g. `createApplePayHandler(bot, { logExpense: failingFake })`, or `createWebhookApp(null, { jobs, telegram, waitUntil, ... })` for the Telegram and cron routes.

## Architecture

### Runtime modes

| | Vercel (production) | Standalone (`npm run dev` / `npm start`) |
|---|---|---|
| Entrypoint | [src/app.ts](src/app.ts) default-exports the Hono app | [src/standalone.ts](src/standalone.ts) |
| Telegram | Telegram POSTs updates to `/api/telegram` | `startPolling()` long-polls |
| Scheduled jobs | Vercel Cron → `/api/cron/recurring`, `/api/cron/digest`, `/api/cron/review` ([vercel.json](vercel.json)) | node-cron (`startRecurringScheduler`, `startDigestScheduler`, `startReviewScheduler`) |
| Database | Turso `libsql://` | `file:` SQLite |
| Migrations | `vercel-build` | on startup |

Both modes build the bot with `createBot()` ([src/bot/index.ts](src/bot/index.ts)) and the HTTP app with `createWebhookApp()` ([src/webhook/index.ts](src/webhook/index.ts)); only the delivery mechanism differs.

- **Vercel entry detection.** Vercel's zero-config Hono support looks for `app`/`index`/`server` files at the root and in `src/`. `src/app.ts` must stay the only such file that imports `hono` — that's why the long-running entry is `src/standalone.ts`, not `src/index.ts`. Don't add a `src/index.ts` or `src/server.ts`.
- **Vercel region.** `vercel.json` pins `hnd1` (Tokyo) to sit next to the Turso database in `aws-ap-northeast-1` — Turso has no Singapore location, and a request makes several DB round trips.
- **Nothing may live in process memory across requests on Vercel** — consecutive updates can hit different instances. That's why `/split` state is in the database, and why the inline buttons carry the transaction id in their callback data rather than the bot remembering what a message was about. The price-fetcher cache is in memory on purpose; losing it just means refetching.
- **`startPolling()` refuses to start while a webhook is registered.** grammy's `start()` calls `deleteWebhook`, so long-polling locally with the production token would silently cut production off from Telegram. Local development uses a separate bot.

### Persistence

One Drizzle database handle over **libSQL**: [src/db/client.ts](src/db/client.ts) (`db`, `getDb()`, `getClient()`, type `Database`). The same `@libsql/client` speaks to a local SQLite file (`file:` URLs — dev and tests) and to Turso (`libsql://` URLs — production), so every query runs unchanged against either. `db` is fully typed (`LibSQLDatabase<typeof schema>`) — keep it that way; it's what catches a missing `await`. The canonical schema is [src/db/schema.ts](src/db/schema.ts).

- **Every query is async.** There's no synchronous driver any more. For multi-statement atomicity use `db.batch([...])` — it runs as one transaction on both a file and Turso (see `replaceHoldingsForBroker`, `reject`, `removeBudget`). Prefer it over `db.transaction()`, which is an interactive transaction (more round trips over HTTP).
- **Foreign keys are not enforced.** SQLite only enforces them per connection, and Turso's remote sessions aren't pinned to one. The schema's `ON DELETE CASCADE` is documentation, not behaviour: `reject()` deletes a user's transactions, income, budgets, alerts, holdings, recurring charges and split session explicitly, and `removeBudget()` deletes its alert rows. **Any new child table must be added to `reject()`.**
- **Migrations** live in `src/db/migrations/` and are generated with `npm run db:generate` (drizzle-kit, `dialect: 'turso'` in [drizzle.config.ts](drizzle.config.ts)): `0000_baseline` (the history squashed when moving to Turso), `0001` (statement prices, `fx_rates`), `0002` (`transactions.spent_at`, `income`), `0003` (`holdings.coingecko_id`). drizzle-kit only generates schema changes — a data backfill, like 0002's `UPDATE transactions SET spent_at = created_at`, is added to the generated file by hand after a `--> statement-breakpoint`. [src/db/migrate.ts](src/db/migrate.ts) runs in `vercel-build`, on standalone startup, and via `npm run db:migrate`; it **skips when `VERCEL_ENV=preview`** so a preview branch can't migrate production, and imports the client lazily so a preview build doesn't need the full config. Read generated SQL before deploying: a new `NOT NULL` column needs a constant default (SQLite can't `ADD COLUMN` one with an expression default — that's why `spent_at` is nullable), and a rename can be generated as drop-and-recreate. Also remember the build migrates while the **previous deployment is still serving**, so new code must tolerate rows the old code writes (see `spentAtColumn`).
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
| `POST /api/apple-pay` | per-user `x-api-key` → `findByWebhookKey`, must be `approved` | [auth.ts](src/webhook/auth.ts): 401 unknown key, 403 unapproved. Logs against that user, confirms on *their* chat with the same buttons a chat expense gets. |
| `GET /api/cron/recurring`, `/digest`, `/review` | `Authorization: Bearer CRON_SECRET` (Vercel sends it) | [routes/cron.ts](src/webhook/routes/cron.ts). Tests override any subset via `options.jobs`. |

The Telegram route **initializes the bot once per instance** (`bot.init()`, memoized; a failure is forgotten and answered with 500 so Telegram retries), then **acknowledges with 200 immediately and processes the update via `waitUntil`** from `@vercel/functions` (a no-op outside Vercel). Replies that call Gemini can take 15–30s; holding Telegram's request open that long risks a timeout and redelivery, i.e. a duplicate expense.

### Request flow (Telegram)

`authMiddleware` ([src/bot/middleware/auth.ts](src/bot/middleware/auth.ts)) resolves `ctx.chat.id` to a `users` row and attaches it as `ctx.user`. Unregistered and `pending_approval` chats get a canned reply unless the message is `/setup` or `/help`. Command handlers start with `if (!ctx.user) return;` and pass `ctx.user.id` down.

**Handler registration order matters.** grammy runs handlers in registration order and the `message:text` handler consumes every text message without calling `next()`, so every `bot.command(...)` must be registered above it.

The `message:text` handler checks `ctx.user.status === 'onboarding'` first (→ `handleSetupTextMessage`), then `await getSplitState(ctx.chat.id)` (→ `handleSplitTextMessage` — an active split bypasses classification entirely), then classifies. When the message is a Telegram *reply* to a message whose buttons name a transaction, that id is passed along as `targetTransactionId`. Free text is classified by [src/bot/ai.ts](src/bot/ai.ts) (`classifyUserMessage(userId, text, now)` — the prompt carries today's date so the model can resolve "yesterday") into a `BotIntent` ([src/bot/types.ts](src/bot/types.ts)), and `buildAssistantReply` returns a `BotReply { text, keyboard? }` after calling a real service for every intent:

| Intent | Action |
|---|---|
| `expense` | `logExpense` (`source: 'text'`, or `'voice'`), passing the classifier's category as `categoryHint` and `extracted.date` as `spentAt` when it's an earlier day (a future date is ignored). The reply shows the original currency next to SGD, the day when it isn't today, any budget alert, and Change category / Undo buttons |
| `income` | `logIncome` ([src/income/service.ts](src/income/service.ts)), dated like an expense, with an Undo button |
| `budget` | `setBudget` in the currency named (default SGD) / `removeBudget` in [src/budget/service.ts](src/budget/service.ts). `matchBudgetCategory` accepts one of our categories or the overall budget ("overall", "total", "monthly"…); anything else gets a question, not a silent "Others" budget; removing a budget that doesn't exist says so |
| `correction` | `correctTransaction(userId, targetTransactionId, field, value)` once per field the message names — the replied-to expense, or the latest. Currency before amount, so the amount's SGD value uses the new currency; `date` moves the expense to that day. Nothing identifiable extracted means a question, not a guess |
| `holdings` | `addHolding`/`removeHolding` in [src/portfolio/service.ts](src/portfolio/service.ts) |
| `query` | `getSpendingSummary` for `today`/`week` (the last 7 days, and labelled so)/`month` (default `month`), via `formatSpendingSummary`. A question about one category gets `formatCategorySpend`, with that category's budget when the period is `month` |
| `recurring` | `createRecurring` — which updates the user's charge for the same merchant (ignoring case and punctuation) rather than adding a second — then `logRecurringIfDue`, so a charge added on its due day is logged now instead of next month. A cancellation goes through `matchRecurring` (exact, else partial; more than one match means a question) and `removeRecurring`. `action: "list"` returns `handleRecurringCommand`, the same reply as `/recurring` |

**Gemini-first by design, deliberately with no rule-based fallback:** if the LLM call fails, `classifyUserMessage` returns `{ intent: 'unknown', serviceError: true }` and the user gets `formatUserFriendlyError()`. Do not reintroduce regex/keyword intent matching — it was tried and removed.

**Inline buttons.** [src/bot/keyboards.ts](src/bot/keyboards.ts) builds every keyboard and documents the callback-data grammar at its top (`t:c|s|d|b:<ctx>:<txId>[:<Category>]`, `t:v:<txId>`, `r:l`, `i:d:<incomeId>`, `h:g|n:<SYMBOL>[:<rank>]`, `rc:d:<recurringId>`; ≤ 64 bytes, which Telegram enforces). Presses reach `bot.on('callback_query:data')` → `handleCallback(userId, data)` ([src/bot/handlers/callback.ts](src/bot/handlers/callback.ts)), which returns a `CallbackOutcome` (`toast`, new `text`, new `keyboard` — `null` removes it) that `applyCallbackOutcome` in [src/bot/index.ts](src/bot/index.ts) applies by editing the message. Callback data is **untrusted client input**: every service it reaches (`getTransaction`, `setTransactionCategory`, `deleteTransaction`, `deleteIncome`) scopes the id to the user who pressed. A reply to a message with such a keyboard corrects that transaction — `transactionIdFromMarkup(reply_to_message.reply_markup)`; Telegram includes the replied-to message's keyboard, so nothing is stored between messages. **The webhook must be registered with `callback_query` in `allowed_updates`** ([src/scripts/telegram-webhook.ts](src/scripts/telegram-webhook.ts) does); one registered before the buttons existed has to be `set` again, or presses never arrive.

`/recent` ([src/bot/commands/recent.ts](src/bot/commands/recent.ts)) lists the last 10 logged expenses as buttons; opening one shows it with Change category / Delete and a way back to the list. `/recurring` ([src/bot/commands/recurring.ts](src/bot/commands/recurring.ts)) lists recurring charges with their monthly SGD total and a Remove button each; a press re-renders the list.

**Photos.** An active `/split` gets the photo. Any other photo is a receipt: `handleReceiptPhoto` ([src/bot/handlers/receipt.ts](src/bot/handlers/receipt.ts)) reads it with `readReceipt` ([src/expense/receipt.ts](src/expense/receipt.ts) — total, currency, printed date and category in one vision call, deliberately lighter than `/split`'s line-item extraction, which rejects receipts whose items don't add up) and logs it straight away (`source: 'receipt'`) with the usual buttons. A receipt date more than 90 days back is treated as a misread. Not a receipt, unreadable, or not in SGD/MYR/USD → `NOT_A_RECEIPT_REPLY` and nothing logged. Statements must therefore be sent as files.

Voice notes ([src/bot/handlers/voice.ts](src/bot/handlers/voice.ts)) are transcribed by the user's provider as multimodal `inlineData`, then routed exactly like typed text (active split first, reply-to-correct too), with the reply prefixed `Heard: "<transcript>"` and `source: 'voice'`.

`/split` ([src/bot/commands/split.ts](src/bot/commands/split.ts)) is a stateful flow backed by [src/split/](src/split/). Its state lives in the **`split_sessions` table** ([src/split/state.ts](src/split/state.ts), all functions async), keyed by chat, **expiring after 2 hours idle** (`SPLIT_SESSION_TTL_MS`, enforced on read) — while a split is active it captures every text message and photo, so a forgotten one mustn't hijack the chat forever.

### Expense engine internals

[src/expense/service.ts](src/expense/service.ts): `logExpense(userId, data)` resolves currency ([currency-resolver.ts](src/expense/currency-resolver.ts) — explicit > card mapping > merchant/note regex > SGD), picks a category, converts to SGD cents via `toSGD` with the day's rates from `getExchangeRates()` (see [Exchange rates](#exchange-rates)), and inserts.

- **Two timestamps.** `spent_at` is when the money went — a backdated "yesterday", a receipt's date, otherwise the moment it was logged. Totals, budgets, alerts, the review and the export go by it, always through `spentAtColumn` = `coalesce(spent_at, created_at)`: migration 0002 backfilled existing rows, but the old deployment keeps writing rows without the column while a new build migrates. `created_at` is when it was logged; "latest" (`/undo`, `correctLastTransaction`, `/recent`) goes by it. Periods are `[start, end)` windows (`listTransactionsBetween`), so a backdated expense lands in its own day and month.
- **Category, cheapest reliable source first** (`resolveExpenseCategory`): what this user last filed the same merchant under (`rememberedCategory` — case-insensitive, newest `updated_at`, so a correction or button change wins), then `data.categoryHint` (the chat classifier's or the receipt reader's), and only then `inferCategory` ([categorizer.ts](src/expense/categorizer.ts) — the user's provider, `'Others'` on failure). A chat expense is one LLM call, not two, and a known merchant from Apple Pay needs none.
- `correctTransaction(userId, transactionId | null, field, value)` changes the given transaction (scoped to the user) or, with `null`, the latest; `correctLastTransaction` is the `null` case. A category the user names (`matchCategory`) is stored as-is; a currency correction accepts only SGD, MYR or USD; `date` (`YYYY-MM-DD`) moves `spent_at`. `getTransaction`, `listRecentTransactions`, `setTransactionCategory` and `deleteTransaction` back the buttons and `/recent`; `undoLastTransaction` removes the latest.
- `exportCSV(userId, year)` picks rows by `spent_at` year and builds the CSV **in memory** (`{ year, filename, content, rowCount }`, with `spent_at` and `created_at` columns); `/export` sends it as a Telegram document. Nothing writes to disk (Vercel's filesystem is read-only).
- `fireRecurringForToday(userId)` is **idempotent within a day**: rows it logs carry `recurring_id`, and it skips any template already logged since the start of today. Vercel Cron can deliver twice, and the standalone process runs it at startup and at midnight. On the last day of a month it also fires templates for days that month doesn't have, so a charge on the 31st still lands in September.

### Income

[src/income/](src/income/): `logIncome`, `deleteIncome` (user-scoped), `listIncomeBetween`, `getIncomeTotal` over the `income` table — kept apart from `transactions` so income can never count as spending. `/month` ([commands/month.ts](src/bot/commands/month.ts)) adds `formatSavings(incomeSgd, spentSgd)`: income, what was saved and the rate, or how far spending passed income; the month review uses the same line. `/undo` doesn't touch income; its Undo button does.

### Portfolio tracker

[src/portfolio/](src/portfolio/):

- `statement-parser.ts` — `parseStatement(userId, { data, kind, mimeType })` reads **any broker's statement, in any layout**, sent as a PDF, an image, or a CSV/text export, with the user's provider. There is no per-broker parser: the prompt asks the model to read the file the way a person would and return strict JSON (broker short name, statement date, and per position the symbol, quantity, unit price and/or market value, ISO currency and asset class). `parseStatementResponse` then validates it: `normalizeBroker` folds names together (so "Interactive Brokers LLC" and "ibkr" are one source), a missing unit price is derived from market value, and a position in an unsupported currency or listed outside the US, SGX and Bursa is **skipped and reported** rather than guessed. The import fails only if nothing is left. Throws `StatementParseError`, no fallback. [document.ts](src/bot/handlers/document.ts)'s `statementFileKind` decides what's readable, checking the file name too because Telegram reports a CSV saved on Windows as `application/vnd.ms-excel`.
- `service.ts` — holdings CRUD, `userId`-scoped. `replaceHoldingsForBroker(userId, broker, holdings, asOf)` replaces one broker's rows for one user in a single `batch`, storing each position's statement `price` and `price_as_of`. `addHolding`/`removeHolding` only touch chat-entered rows (`broker IS NULL`); `addHolding` throws `StatementHoldingConflictError` rather than double-count a symbol a statement already holds, and `removeHolding` returns the rows removed so the bot can say why nothing was.
- `price-fetcher/` — **stocks and ETFs are valued at their latest statement price; there are no live stock quotes.** A newer statement from the same broker replaces the price. Crypto is priced live from CoinGecko by coin id: from the checked `COINGECKO_IDS` table, or, for any other coin, the `holdings.coingecko_id` the user picked. Tickers collide, so a coin is never priced by ticker alone: adding one outside the table runs `searchCoins` (exact ticker, ranked coins only, largest first) and the holdings reply offers the matches as buttons. A press (`h:g:<SYMBOL>:<rank>`) re-searches and resolves the coin with `findCoinByRank`, because a CoinGecko id can overflow the 64-byte callback data, then `setCoingeckoId` stores it. No match, or "None of these", leaves the coin unpriced at S$0. Cash has no quote and is valued at face value. `PriceQuote.change_pct` is null for a statement price, and `source` says which kind a quote is.
- `calculator.ts` — pure net worth/allocation math. `enrichHolding(holding, quote, rates)` takes the exchange rates explicitly; `getPortfolioSummary` ([index.ts](src/portfolio/index.ts)) fetches them once per summary.
- `advice.ts` — `generatePortfolioAdvice`; see the digest below.

In chat, only crypto and cash can be added. The holdings intent points a stock or ETF to statement upload (a hand-entered stock would have no price), asks about a symbol it can't place instead of defaulting to crypto, and says when a coin has no price source.

### Budget, review and digest modules

- [src/budget/](src/budget/) — budgets are monthly, one per category or the **overall** budget (`OVERALL_BUDGET = 'Overall'`, `BudgetCategory = Category | 'Overall'` in [src/types/budget.ts](src/types/budget.ts)), which counts all spending (`spentAgainst`). `setBudget`/`removeBudget`/`listBudgets` (overall first)/`findBudgetByCategory`/`matchBudgetCategory` ([service.ts](src/budget/service.ts)). `getBudgetStatus(userId, now)` ([progress.ts](src/budget/progress.ts)) gives spend vs limit, days left, and `projected_sgd` — `projectMonthEnd`: spend ÷ day of month × days in month, from the 7th (`PACE_MIN_DAY`); `/budget` shows "on pace for" when that overshoots a budget still under its limit. `checkAlerts(userId, transaction, now)` ([alerts.ts](src/budget/alerts.ts)) returns **an array** — for the transaction's category budget, then the overall budget — of whatever each newly crossed this month: 100%, else 80%, else (below 80%) a pace warning when the projection exceeds the budget by more than 10%. Each is sent at most once per budget per month (`budget_alerts`; pace is stored as threshold `0`). An expense dated in another month triggers nothing. **Every path that logs or changes an expense checks it**: `budgetAlertFor` — which never throws, because the expense is already saved and an error would make the user retry and log it twice, and which joins multiple alerts into one message — is used by chat and voice replies, corrections, category changes from buttons, receipts, Apple Pay and `/split` shares; the recurring job goes through `deliverBudgetAlerts`. Reply text lives in [src/bot/formatter/messages.ts](src/bot/formatter/messages.ts).
- [src/review/](src/review/) — the month-end review. `buildMonthReview(userId, now)` reviews the month before `now`'s: `collectMonthReview` (spend vs the month before, categories with their change, the top 3 merchants folded by case, income, and each budget's outcome — against its *current* amount, since budgets aren't versioned) + `formatMonthReview`. Deterministic, no LLM call. `null` for a month with nothing logged: the job skips that user, `/review` says there's nothing to review.
- [src/digest/](src/digest/) — `buildDigestMessage(userId)` = `collectDigestData(userId)` + `generateSummaryLine(userId, data)` + `formatDigestMessage`. Each section is `settle()`-wrapped so one failure degrades only that section. `generateSummaryLine` **keeps a rule-based fallback** (deliberate, unlike other LLM call sites). The portfolio section runs `getPortfolioSummary` → `generatePortfolioAdvice` ([src/portfolio/advice.ts](src/portfolio/advice.ts)), which hands the model the *already-computed* prices and SGD values and never asks it to produce a number; no holdings → a friendly empty state without an LLM call. `/digest` builds it on demand for the caller.

### Scheduled jobs

`triggerRecurringNow(bot)` ([src/scheduler/recurring.ts](src/scheduler/recurring.ts)), `triggerDigestNow(bot)` ([src/digest/index.ts](src/digest/index.ts)) and `triggerMonthReviewNow(bot)` ([src/review/index.ts](src/review/index.ts)) each loop `listApproved()`, isolate per-user failures, and send proactively via `bot.api.sendMessage(user.telegram_chat_id, ...)`. They're triggered by:

- **Vercel Cron** — [vercel.json](vercel.json) schedules are **UTC**: `0 14 * * *` → digest at 22:00 SGT, `0 16 * * *` → recurring at 00:00 SGT, `0 1 1 * *` → month review at 09:00 SGT on the 1st. On Hobby a job fires once at some point within the scheduled hour. If `APP_TIMEZONE` changes, change these too.
- **node-cron** in the standalone process — `0 22 * * *`, `0 0 * * *` and `0 9 1 * *` in `APP_TIMEZONE`, plus a startup catch-up run of the recurring job.

### Exchange rates

Supported currencies are **SGD, MYR and USD** (ISO 4217); crypto is an asset priced in USD, not a currency. Rates are "units of each currency per 1 SGD", and `toSGD(amount, currency, rates)` / `convertCurrency` in [src/config/currencies.ts](src/config/currencies.ts) take them explicitly — that file does no I/O. [src/fx/rates.ts](src/fx/rates.ts)'s `getExchangeRates()` supplies them: live from exchangerate-api.com (`EXCHANGE_RATE_API_KEY`, SGD base, so the response is already per-SGD), cached for a day in memory **and** in the `fx_rates` table. The table is what makes the TTL hold on Vercel, where a memory-only cache would call the API on nearly every cold start (free plan: 1,500 requests a month). A failed refresh uses the last stored rates however old, then `FALLBACK_EXCHANGE_RATES`, and isn't retried for an hour — conversions never fail because the API is down. Every caller that stores or shows an SGD amount (`logExpense`, `correctTransaction`, `logIncome`, the recurring job, `setBudget`, `getPortfolioSummary`) awaits `getExchangeRates()` first. Never log the request URL: it contains the key.

### Config and types

- [src/config/env.ts](src/config/env.ts): Zod-validated, loaded once at import; throws on invalid config. **`ENCRYPTION_KEY` is the only unconditionally required var.** `ADMIN_CHAT_ID` is required when `TELEGRAM_BOT_TOKEN` is set; `DATABASE_AUTH_TOKEN` is required when `DATABASE_URL` is `libsql://`. `DATABASE_URL` defaults to `file:./data/pluto.db` and a bare path is normalized to `file:`. `TELEGRAM_WEBHOOK_SECRET` (Telegram's `[A-Za-z0-9_-]` alphabet) and `CRON_SECRET` are only needed on Vercel. `EXCHANGE_RATE_API_KEY` turns on live exchange rates; without it conversions use `FALLBACK_EXCHANGE_RATES`. Empty values in `.env` count as unset. `GOOGLE_API_KEY`, `WEBHOOK_API_KEY`, and `TELEGRAM_AUTHORIZED_CHAT_ID` were **removed** — don't reintroduce global secrets.
- **Timezone:** Vercel reserves `TZ` (always UTC), so env.ts sets `process.env.TZ = config.APP_TIMEZONE` (default `Asia/Singapore`) at load, before any date math. All "today"/month/day-of-month logic uses local time and depends on this; [src/utils/dates.ts](src/utils/dates.ts) holds the shared helpers (`parseIsoDate` → local noon, `earlierDay`, `startOfMonth`, `monthKey`…).
- [src/config/currencies.ts](src/config/currencies.ts): the `Currency` union (SGD, MYR, USD), `DEFAULT_CARD_CURRENCY_MAP`, `FALLBACK_EXCHANGE_RATES`, and the pure conversion functions — see [Exchange rates](#exchange-rates). [currencies.test.ts](src/config/currencies.test.ts) fails on a fallback rate entered the wrong way round (MYR once was, making RM 45 count as S$150).
- [src/types/](src/types/): shared domain types (`Transaction` with `spent_at`, `Income`, `BudgetCategory`). Add new domain types here first.

### Data files

Locally, `./data/pluto.db` is the development database (gitignored, created on demand). Each test file uses its own `./data/test-*.db` and deletes it at start, which keeps the suite parallel-safe. [src/scripts/telegram-webhook.ts](src/scripts/telegram-webhook.ts) (`npm run telegram:webhook`) registers the production webhook; it deliberately doesn't load `src/config`.
