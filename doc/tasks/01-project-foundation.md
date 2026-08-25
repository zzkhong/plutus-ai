# PLUTO-01: Project Foundation

| Field | Value |
|-------|-------|
| Module | Project Foundation |
| Priority | P0 — Critical Path |
| Dependencies | None |
| Estimated effort | Medium |

---

## Description

Set up the project scaffolding, database schema, shared configuration,
and common types that all other modules depend on. This is the
foundational layer — nothing else can start until this is complete.

---

## Acceptance Criteria

- [x] Project initialized with package.json, TypeScript config, linting
      (ESLint 10 with flat config in eslint.config.mjs)
- [x] Database schema designed and migrations created for: transactions,
      holdings, budgets, recurring_transactions, user_config
      (schema in src/db/schema.ts; Drizzle migrations in src/db/migrations/;
      automatic migration on startup via src/db/client.ts)
- [x] Environment configuration system (dotenv or similar) with
      validation for required keys
- [x] Shared TypeScript types/interfaces exported for cross-module use
- [x] Currency constants defined (SGD, MYR, USD, BTC, ETH, BETH)
- [x] Card-to-currency mapping configuration structure
- [x] Database connection utility with basic error handling
- [x] Project runs locally with `npm run dev` (even if it does nothing
      yet)
- [x] README with setup instructions

---

## Technical Scope

### Stack Decisions

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Runtime | Node.js + TypeScript | Type safety, async-first |
| Database | SQLite (via better-sqlite3 or Drizzle) | Zero cost, single-user, file-based |
| AI Model | Google Gemini Flash (free tier) | 1500 req/day, zero cost |
| Bot Framework | grammy or telegraf | Telegram bot library |
| Scheduler | node-cron | Daily digest trigger |
| HTTP | Hono or Express | Webhook endpoint for iOS Shortcut |

### Files to Create

```
src/
├── index.ts                  # Entry point
├── config/
│   ├── env.ts                # Environment variable loading & validation
│   ├── currencies.ts         # Currency constants & card mapping types
│   └── index.ts
├── db/
│   ├── schema.ts             # Database schema definitions
│   ├── migrations/           # Migration files
│   ├── client.ts             # DB connection singleton
│   └── index.ts
├── types/
│   ├── transaction.ts        # Transaction, Category types
│   ├── portfolio.ts          # Holding, AssetClass types
│   ├── budget.ts             # Budget types
│   └── index.ts
├── utils/
│   ├── currency.ts           # Currency conversion helpers
│   └── logger.ts             # Simple logging utility
package.json
tsconfig.json
.env.example
```

### Database Schema (Core Tables)

```sql
transactions (
  id, amount, currency, amount_sgd, merchant, category,
  source, card_name, note, created_at
)

holdings (
  id, symbol, name, asset_class, quantity REAL, currency,
  market, created_at, updated_at
)

budgets (
  id, category, amount, currency, amount_sgd, period, created_at
)

recurring_transactions (
  id, amount, currency, merchant, category, day_of_month,
  is_active, created_at
)

user_config (
  key, value
)
```

---

## Interface Contracts (Exports for Other Modules)

```typescript
// Types consumed by Expense Engine, Portfolio, Budget, Digest
export type Transaction = { ... }
export type Holding = { ... }
export type Budget = { ... }
export type RecurringTransaction = { ... }
export type Currency = 'SGD' | 'MYR' | 'USD' | 'BTC' | 'ETH' | 'BETH'
export type Category = 'Food' | 'Transport' | 'Shopping' | ...
export type AssetClass = 'stocks_us' | 'stocks_my' | 'crypto' | 'cash'

// DB client
export { db } from './db/client'

// Config
export { config } from './config/env'
export { cardCurrencyMap } from './config/currencies'
```

---

## Notes

- SQLite chosen for zero-cost, single-user simplicity. File lives in
  `data/pluto.db`.
- All monetary amounts stored as integers (cents) to avoid floating
  point issues.
- `amount_sgd` is the normalized base currency value for all reporting.
- Card-to-currency mapping is user-configurable (stored in user_config
  or a JSON file).
- `GOOGLE_API_KEY` is a required env var, not optional — env validation
  should fail startup if it's missing. Pluto AI classifies every message
  through Gemini (see PLUTO-02) and has no rule-based fallback, so there
  is no valid "no key" mode to support.
- `npm run lint` now runs (ESLint 10 with flat config in
  `eslint.config.mjs`), but the checkout is not currently lint-clean —
  as of 2026-08-26 it reports 21 errors, almost all
  `@typescript-eslint/no-explicit-any` in `src/expense/service.ts` (the
  raw `better-sqlite3` query results) plus `src/bot/middleware/auth.ts`
  and `error.ts`, one `preserve-caught-error` in `src/config/env.ts`,
  and an unused `db` import in `src/index.ts`. The config itself is
  fixed; the remaining errors are real code-quality debt, not a broken
  toolchain.
- Drizzle migrations are now set up: schema is in `src/db/schema.ts`,
  migrations in `src/db/migrations/`, and automatic migration runs on
  app startup via `src/db/client.ts`. Use `npm run db:generate` to
  create new migrations and `npm run db:migrate` to apply them manually.

---

## Improvisation / Suggested Next Steps

- Fix the 21 outstanding lint errors before they compound — most are
  `no-explicit-any` on raw SQLite row results in
  `src/expense/service.ts`, which is exactly the kind of file that
  benefits from a typed row shape (a `TransactionRow` interface cast
  once at the query boundary) instead of `any` sprinkled through every
  consumer.
- `src/index.ts` imports `db` from `./db` purely for its side effect
  (triggering the singleton/migration) but never uses the binding,
  which is what lint is flagging. Either rename the import to `_db` or,
  better, expose an explicit `initializeDatabase()` call so the
  side-effecting import isn't relied upon implicitly.
- The comment in `src/index.ts` above the database step still describes
  "runs CREATE TABLE IF NOT EXISTS for all core tables" — that was true
  before this task's Drizzle migration work landed; `src/db/client.ts`
  now runs `migrate()` against `src/db/migrations/` instead. Worth a
  one-line comment fix so future readers aren't misled about how the
  schema actually gets applied.
