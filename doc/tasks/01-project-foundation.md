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

- [ ] Project initialized with package.json, TypeScript config, linting
- [ ] Database schema designed and migrations created for: transactions,
      holdings, budgets, recurring_transactions, user_config
- [ ] Environment configuration system (dotenv or similar) with
      validation for required keys
- [ ] Shared TypeScript types/interfaces exported for cross-module use
- [ ] Currency constants defined (SGD, MYR, USD, BTC, ETH, BETH)
- [ ] Card-to-currency mapping configuration structure
- [ ] Database connection utility with basic error handling
- [ ] Project runs locally with `npm run dev` (even if it does nothing
      yet)
- [ ] README with setup instructions

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
