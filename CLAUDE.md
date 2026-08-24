# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Plutus AI is a personal finance assistant: a Telegram bot (Grammy) backed by SQLite (better-sqlite3 + Drizzle ORM) that logs expenses, tracks a portfolio, manages budgets, and (eventually) sends an AI-powered daily digest. Message understanding is Gemini-first with no rule-based fallback — `GOOGLE_API_KEY` is a required env var. The product spec lives in [doc/pluto-ai-prd.md](doc/pluto-ai-prd.md) and the module build-out plan is in [doc/tasks/](doc/tasks/) (01 foundation → 07 iOS Shortcuts integration). The repo is currently mid-build: only foundation, the Telegram bot shell, and the expense engine (tasks 01–03) are implemented; portfolio, budget, digest, and iOS Shortcuts handlers are stubs.

## Commands

```bash
npm run dev      # run with tsx (hot reload, no build step)
npm run build     # tsc -> dist/
npm run start     # run compiled dist/index.js
npm run lint      # eslint src --ext .ts
npm run format    # prettier --write src/**/*.ts
npm test          # node's built-in test runner over the two *.test.ts files below
```

There is no test-file globbing — `npm test` runs exactly `src/bot/ai.test.ts` and `src/expense/expense.test.ts` via `npx tsx --test`. To run a single test file or filter by name:

```bash
npx tsx --test src/expense/expense.test.ts
npx tsx --test --test-name-pattern="undoLastTransaction" src/expense/expense.test.ts
```

New test files must be added explicitly to the `test` script in [package.json](package.json) or they won't run.

[src/bot/ai.test.ts](src/bot/ai.test.ts) makes a real call to the Gemini API using `GOOGLE_API_KEY` from `.env` to verify classification end-to-end (there's no mocking seam for the SDK) — it needs network access and a working key, and will fail without either. Its "Gemini call fails" test stubs `global.fetch` instead, so it doesn't need network.

`npm run lint` is currently broken on a clean checkout: the installed `eslint@^10` requires a flat `eslint.config.js`, but the repo still ships the legacy [.eslintrc.js](.eslintrc.js). This is a pre-existing issue, not introduced by any particular change — fix it (migrate the config or pin eslint to v8) before relying on lint output.

## Architecture

### Two independent SQLite access paths — read before touching persistence

There are **two separate places that open the SQLite database and create tables**, and they are not unified:

- [src/db/client.ts](src/db/client.ts) — a Drizzle-wrapped singleton (`db`, `getDb()`), opened once at import time, used for the canonical schema ([src/db/schema.ts](src/db/schema.ts)).
- [src/expense/service.ts](src/expense/service.ts) — every exported function (`logExpense`, `getSpendingSummary`, `exportCSV`, etc.) opens its **own** raw `better-sqlite3` connection via `getSQLiteDb()`, runs `CREATE TABLE IF NOT EXISTS` for `transactions`/`recurring_transactions` again, executes hand-written SQL, and closes the connection before returning. It does not go through Drizzle or `src/db/`.

Both point at the same file (`config.DATABASE_URL`) and the table definitions are kept in sync by hand — if you change a column in [src/db/schema.ts](src/db/schema.ts), update the raw `CREATE TABLE`/`INSERT`/`SELECT` strings in [src/expense/service.ts](src/expense/service.ts) too. When adding new persistence code, prefer extending the expense module's raw-SQL pattern for consistency with existing expense/recurring code, or ask whether to migrate that module onto Drizzle — don't silently mix a third approach in.

### Request flow (Telegram)

`src/index.ts` → constructs `PlutoBot` ([src/bot/index.ts](src/bot/index.ts)) if `TELEGRAM_BOT_TOKEN` is set → middleware chain (`authMiddleware` single-chat allowlist, then `errorHandlerMiddleware`) → command handlers (`/portfolio`, `/today`, `/month`, `/budget`, `/export`, `/undo`, `/help`) in [src/bot/commands/](src/bot/commands/), or free-text/voice messages routed through [src/bot/handlers/text.ts](src/bot/handlers/text.ts) / `voice.ts`.

Free text is classified by [src/bot/ai.ts](src/bot/ai.ts) (`classifyUserMessage` → Gemini) into a `BotIntent` (`expense | query | budget | correction | recurring | help | unknown`), then `buildAssistantReply` generates a canned response per intent. **Pluto AI is Gemini-first by design, deliberately with no rule-based fallback** (see [doc/tasks/02-telegram-bot.md](doc/tasks/02-telegram-bot.md)): `GOOGLE_API_KEY` is a required env var — startup fails without it (see [src/config/env.ts](src/config/env.ts)) — and if the Gemini call itself fails at runtime (timeout, network error, unparseable JSON), `classifyUserMessage` returns `{ intent: 'unknown', serviceError: true }` rather than guessing via keywords; `buildAssistantReply` turns that into the generic `formatUserFriendlyError()` message. Do not reintroduce regex/keyword intent matching as a substitute for a real Gemini response — that was tried and explicitly removed. The model id is pinned explicitly (`gemini-3.6-flash` as of 2026-08) rather than an alias, since Gemini model ids get deprecated over time; if classification starts failing, check `GET /v1beta/models` against the configured key. The classification call has a generous timeout (15s) because this model's reasoning overhead routinely runs close to 5s for the classification prompt.

**This classification path is not yet wired to the expense engine** — an "expense" intent from free text currently only returns an acknowledgement string; it does not call `logExpense`. Only the `/today`, `/month`, `/export`, `/undo` slash commands and the (as yet unwired) iOS Shortcuts endpoint actually persist transactions via [src/expense/service.ts](src/expense/service.ts).

`/portfolio` and `/budget` are hardcoded placeholder strings — the portfolio tracker (task 04) and budget system (task 05) haven't been implemented.

### Expense engine internals

[src/expense/service.ts](src/expense/service.ts) is the core: `logExpense` resolves currency (`resolveCurrency` in [currency-resolver.ts](src/expense/currency-resolver.ts) — explicit currency > card-name mapping > regex on merchant/note > SGD default), infers category (`inferCategory` in [categorizer.ts](src/expense/categorizer.ts) — regex over merchant+note against a fixed category list), converts to SGD cents via `toSGD` ([src/config/currencies.ts](src/config/currencies.ts), hardcoded `EXCHANGE_RATES`), and inserts. All monetary amounts are stored as **integer cents**, never floats/decimals. `amount_sgd` is always the SGD-normalized value used for summaries/budgets regardless of the original currency.

`correctLastTransaction(field, value)` only ever mutates the single most-recent transaction — there's no way to target an arbitrary past transaction.

### Config and types

- [src/config/env.ts](src/config/env.ts): Zod-validated env vars, loaded once at import time; throws on invalid config. `GOOGLE_API_KEY` is **required** — startup fails without it, since there is no fallback classification path. `TELEGRAM_BOT_TOKEN` and `TELEGRAM_AUTHORIZED_CHAT_ID` are optional — their absence changes runtime behavior (bot doesn't start / auth is open to any chat) rather than failing startup.
- [src/config/currencies.ts](src/config/currencies.ts): supported `Currency` union (`SGD | MYR | USD | BTC | ETH | BETH`), `DEFAULT_CARD_CURRENCY_MAP`, and hardcoded `EXCHANGE_RATES` (not fetched live — update manually if rates drift).
- [src/types/](src/types/): shared domain types (`transaction.ts`, `portfolio.ts`, `budget.ts`), re-exported from `src/types/index.ts`. Add new domain types here first, before wiring up config/db/logic, per the existing task breakdown.

### Data files

`./data/pluto.db` is the runtime database (gitignored, created on demand); `./data/test-plutus.db` is deleted and recreated by [src/expense/expense.test.ts](src/expense/expense.test.ts) on each run. CSV exports from `/export` land in `./data/exports/`.
