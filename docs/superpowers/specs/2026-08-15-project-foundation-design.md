# PLUTO-01: Project Foundation — Design

Source requirements: [docs/tasks/01-project-foundation.md](../../tasks/01-project-foundation.md)

## Goal

Stand up the scaffolding every other module depends on: TypeScript
project config, a SQLite schema for the five core tables, env-var
validation, shared domain types, currency constants, and a database
connection singleton — enough that `npm run dev` boots cleanly with no
feature behavior yet.

## Scope decisions (resolved during initial implementation)

- **SQLite + better-sqlite3, wrapped by Drizzle ORM.** Zero operational
  cost, single-user, file-based, and Drizzle gives typed schema
  definitions without a server process. `./data/pluto.db` is the
  runtime file (gitignored, directory created on demand by
  `src/db/client.ts`).
- **All monetary amounts are integer cents.** Every table that stores
  money (`transactions.amount`, `budgets.amount`, etc.) is an
  `integer`, never a float, to avoid rounding drift. `amount_sgd`
  columns hold the SGD-normalized value so cross-currency reporting
  never has to re-convert at read time.
- **Static exchange rates now, live rates later.** `src/config/currencies.ts`
  ships a hardcoded `EXCHANGE_RATES` table and a synchronous `toSGD`/
  `convertCurrency` pair so early modules (expense engine) have
  something to call immediately. `src/config/exchange-rates.ts` is
  built alongside it as the intended eventual replacement — an async,
  24-hour-cached `getExchangeRates()` with a placeholder
  `fetchExchangeRatesFromAPI()` that currently just returns the same
  fallback table. No module calls the async path yet; it exists so a
  future task can wire a real provider (exchangerate-api.com, Fixer,
  etc.) without touching call sites twice.
- **`GOOGLE_API_KEY` is a required env var, not optional.** This was
  tightened after the fact (see PLUTO-02's design doc for the full
  story) — Pluto AI has no rule-based fallback for message
  understanding, so a missing key must fail startup loudly via Zod
  rather than let the app run in a degraded mode that silently
  guesses. `TELEGRAM_BOT_TOKEN` and `TELEGRAM_AUTHORIZED_CHAT_ID` stay
  optional: their absence changes runtime behavior (bot doesn't start
  / auth open to any chat) instead of blocking startup, since the
  webhook and CLI-only paths don't need them.
- **Schema evolved from inline `CREATE TABLE IF NOT EXISTS` to Drizzle-generated
  migrations.** The first cut of `src/db/client.ts` created tables with
  hand-written `CREATE TABLE IF NOT EXISTS` strings run on every boot.
  This was replaced with `drizzle-kit generate` output under
  `src/db/migrations/` plus `migrate()` from
  `drizzle-orm/better-sqlite3/migrator`, run automatically by
  `initializeDatabase()` on startup — the schema and the migration
  history are now the same source of truth instead of a hand-maintained
  string that could drift from `src/db/schema.ts`. `npm run db:generate`
  produces new migrations; `npm run db:migrate` (`tsx src/db/migrate.ts`)
  applies them standalone, and `runMigrations()` from that file is the
  hook used by every test file that needs a schema (see Testing below).
- **ESLint evolved from legacy `.eslintrc.js` to flat config.** The
  original scaffold shipped `.eslintrc.js` (ESLint 8-style). The
  installed `eslint` was later bumped to v10, which only understands
  flat config, so `.eslintrc.js` stopped working. It was replaced with
  `eslint.config.mjs` (`@eslint/js` recommended rules +
  `@typescript-eslint` for `src/**/*.ts`, `no-unused-vars` as an error
  with a `^_` ignore pattern for intentionally-unused params, `no-explicit-any`
  as a warning). `npm run lint` runs clean against this config.
- **Two persistence styles, by design, not by accident.** Foundation
  only establishes the Drizzle path (`src/db/client.ts` / `src/db/schema.ts`).
  The expense engine (PLUTO-03) later opens its own raw
  `better-sqlite3` connection per call instead of going through
  Drizzle — that's a PLUTO-03 decision, not a foundation one, but it's
  worth flagging here because both paths point at the same
  `config.DATABASE_URL` file and their table definitions have to be
  kept in sync by hand.
- **`user_config` ships as a schema-only placeholder.** The task doc
  calls for a key-value table for user preferences (e.g. an
  eventual UI-driven card→currency override). It's defined in the
  schema and migrated, but nothing reads or writes it yet — card→currency
  mapping instead lives as a static `DEFAULT_CARD_CURRENCY_MAP` object
  in `src/config/currencies.ts`. Revisit if/when card mapping needs to
  be user-editable at runtime instead of a code change.

## Module layout

```
src/
├── index.ts                  # Entry point — logs boot info, no wiring yet
├── config/
│   ├── env.ts                # Zod-validated env vars (config singleton)
│   ├── currencies.ts         # Currency map, static EXCHANGE_RATES, conversion helpers
│   ├── exchange-rates.ts     # Async cached rate lookup, placeholder API call
│   └── index.ts               # Re-exports env.ts + currencies.ts
├── db/
│   ├── schema.ts              # Drizzle table definitions (5 core tables)
│   ├── client.ts              # getDb()/db singleton, runs migrations on init
│   ├── migrate.ts             # Standalone migration runner (npm run db:migrate)
│   ├── migrations/            # drizzle-kit generated SQL + meta/_journal.json
│   └── index.ts
├── types/
│   ├── transaction.ts         # Currency, Category, Transaction, RecurringTransaction
│   ├── portfolio.ts            # AssetClass, Holding, Portfolio
│   ├── budget.ts               # BudgetPeriod, Budget, BudgetSummary
│   └── index.ts
└── utils/
    ├── currency.ts             # currencyUtils wrapper over config/currencies.ts
    ├── logger.ts                # Leveled console logger
    └── index.ts

drizzle.config.ts               # schema/out/dialect/dbCredentials for drizzle-kit
tsconfig.json                   # ES2020, commonjs, strict, rootDir src -> dist
eslint.config.mjs               # Flat ESLint config (see scope decision above)
package.json                    # scripts: dev/build/start/lint/format/test/db:*
.env.example
README.md
```

### `config/env.ts`

```typescript
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().default('./data/pluto.db'),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_AUTHORIZED_CHAT_ID: z.string().optional(),
  GOOGLE_API_KEY: z.string().min(1, '...'), // required, no default
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  PORT: z.string().default('3000'),
  WEBHOOK_API_KEY: z.string().optional(), // added later by PLUTO-07
});

export type Config = z.infer<typeof envSchema>;
export const config = loadConfig(); // throws on invalid/missing required vars
```

`loadConfig()` calls `dotenv.config()` then `envSchema.parse(process.env)`;
a `ZodError` is logged via `console.error(error.flatten())` and rethrown
as a plain `Error('Invalid environment configuration')` so `src/index.ts`'s
top-level catch can `process.exit(1)` cleanly. `WEBHOOK_API_KEY` was
added to this same schema by PLUTO-07 without changing its shape — noted
here since this file is foundation-owned infrastructure other modules
extend.

### `config/currencies.ts`

```typescript
export const CURRENCIES: Record<Currency, { symbol: string; name: string }>
export const BASE_CURRENCY: Currency = 'SGD'
export const DEFAULT_CARD_CURRENCY_MAP: Record<string, Currency>
export const EXCHANGE_RATES: Record<Currency, number> // static, SGD = 1.0

export function convertCurrency(amount: number, from: Currency, to: Currency): number
export function toSGD(amount: number, currency: Currency): number
export function formatCurrency(amount: number, currency: Currency): string
```

`DEFAULT_CARD_CURRENCY_MAP` ships with `OCBC`, `OCBC iPhone`, `DBS`,
`UOB` → `SGD` and `Crypto.com`, `Binance`, `Gemini` → `USD`. There is
**no `Maybank` entry** — PLUTO-03's acceptance criteria calls this out
explicitly as an unmet example (`Maybank = MYR`) still open as of that
module's implementation.

### `db/schema.ts` — the five core tables

```typescript
export const transactions = sqliteTable('transactions', {
  id, amount, currency, amount_sgd, merchant, category, source,
  card_name, note, created_at, updated_at,
});
export const holdings = sqliteTable('holdings', {
  id, symbol, name, asset_class, quantity /* real */, currency, market,
  cost_basis /* nullable */, created_at, updated_at,
});
export const budgets = sqliteTable('budgets', {
  id, category, amount, currency, amount_sgd, period, created_at, updated_at,
});
export const recurring_transactions = sqliteTable('recurring_transactions', {
  id, amount, currency, merchant, category, day_of_month,
  is_active /* 0|1 */, created_at, updated_at,
});
export const user_config = sqliteTable('user_config', {
  key /* PK */, value,
});
```

`created_at`/`updated_at` default to `unixepoch() * 1000` (milliseconds)
at the SQL level via `sql\`(unixepoch() * 1000)\``. `is_active` is
stored as integer 0/1 (SQLite has no boolean type) and mapped to a JS
`boolean` by whichever service reads it. The `budget_alerts` table
visible in the current `src/db/schema.ts` and migration
`0001_sleepy_psynapse.sql`/`0002_fat_shiver_man.sql` was added later by
PLUTO-05 (budget system) — out of scope for this module, called out
here only so the file tree above isn't read as foundation's own design.

### `db/client.ts`

```typescript
export function getDb(): ReturnType<typeof drizzle>
export const db: any = getDb(); // singleton, created at import time
```

`initializeDatabase()` ensures the `./data` directory exists, opens the
SQLite file, turns on `PRAGMA foreign_keys = ON`, wraps it with
`drizzle(sqliteDb, { schema })`, then calls `migrate(db, { migrationsFolder })`
synchronously before returning — so importing `db` from anywhere
triggers migrations as a side effect. `src/db/migrate.ts` is a second,
standalone entry point (`npm run db:migrate`) for applying migrations
without booting the whole app, and is also what every test file that
touches the database calls in a `before()` hook after pointing
`DATABASE_URL` at a scratch file.

### `types/`

`src/types/index.ts` re-exports `transaction.ts` (`Currency`, `Category`,
`Transaction`, `RecurringTransaction`), `portfolio.ts` (`AssetClass`,
`Holding`, `Portfolio`), and `budget.ts` (`BudgetPeriod`, `Budget`,
`BudgetSummary`). These are the types every later module (expense,
budget, digest, webhook) imports from `../types` rather than
redefining. `Category` is a fixed 10-value union (`Food | Transport |
Shopping | Entertainment | Bills | Health | Education | Travel |
Groceries | Others`) — no module has added a category since.

### `utils/`

`currency.ts` exports a `currencyUtils` object (`convert`, `toSGD`,
`format`, `getName`, `getSymbol`) that's a thin wrapper over
`config/currencies.ts` — kept as a separate module so call sites can
import either `{ toSGD }` from `../config` directly or the grouped
`currencyUtils` object, per convention at the call site. `logger.ts` is
a small leveled console logger (`debug`/`info`/`warn`/`error`) gated by
`config.LOG_LEVEL`, used by every module built afterward instead of
raw `console.log`.

## Data model

See `db/schema.ts` above. `drizzle.config.ts` points `drizzle-kit` at
`./src/db/schema.ts` (input) and `./src/db/migrations` (output) for
the `sqlite` dialect, reading `DATABASE_URL` from the environment for
introspection.

## Wiring into the rest of the app

`src/index.ts` at this stage only imports `db` (to trigger the
migration side effect) and logs boot status — no bot, no scheduler, no
webhook yet (those land in PLUTO-02, PLUTO-03's scheduler, and
PLUTO-07 respectively). `npm run dev` (`tsx src/index.ts`) is expected
to start, log `Plutus AI application is ready!`, and exit only on
`Ctrl+C` — there's deliberately nothing else to observe yet, per the
task doc's "even if it does nothing yet" acceptance criterion.

## Testing

No dedicated test file for this module — foundation has no business
logic to unit test at this stage (env validation and DB connection are
exercised implicitly by every other module's test file, all of which
set `DATABASE_URL` to a scratch path and call `runMigrations()` in a
`before()` hook). Verification was manual: `npm run dev` boots cleanly,
`npm run build` type-checks and emits `dist/`, `npm run lint` passes
against the flat config.

## Out of scope

- Live exchange rate fetching — `src/config/exchange-rates.ts`'s
  `fetchExchangeRatesFromAPI()` is a placeholder that returns the same
  static fallback table; no module calls it yet.
- A UI or chat flow for editing `user_config` or
  `DEFAULT_CARD_CURRENCY_MAP` at runtime — both are static/code-defined
  for now.
- Any actual database queries beyond the connection singleton and
  migration runner — CRUD lives in each domain module (expense,
  budget, etc.), not in `src/db/`.
- Webhook/HTTP server scaffolding — `PORT` and (later) `WEBHOOK_API_KEY`
  are reserved in the env schema, but no HTTP server exists until
  PLUTO-07.
