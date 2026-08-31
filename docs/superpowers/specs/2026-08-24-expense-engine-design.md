# PLUTO-03: Expense Engine — Design

Source requirements: [docs/tasks/03-expense-engine.md](../../tasks/03-expense-engine.md)

## Goal

The core transaction engine: log expenses from any input channel,
categorize them via Gemini, resolve and convert currency to SGD, allow
undo/correction of the most recent transaction, answer spending
queries (today/week/month, by category), auto-fire recurring
transactions on schedule, and export a year's transactions to CSV.

## Scope decisions (resolved during initial implementation)

- **A second, independent SQLite access path — deliberate, not
  accidental.** PLUTO-01 established `src/db/client.ts` as a
  Drizzle-wrapped singleton for the canonical schema. This module
  instead has every exported function in `src/expense/service.ts` open
  its **own** raw `better-sqlite3` connection via `getSQLiteDb()`,
  run hand-written SQL, and `db.close()` before returning — it does
  not import or use Drizzle or `src/db/` at all. The tradeoff: simpler
  synchronous-feeling code with full control over the exact SQL run
  (useful for the aggregation queries this module needs), at the cost
  of two schema definitions that must be kept in sync by hand (`src/db/schema.ts`'s
  Drizzle tables vs. this module's implicit reliance on those same
  tables already existing via migrations). This wasn't reversed later;
  subsequent modules had to choose explicitly which style to follow
  (budget system chose Drizzle; the digest module's read-only query
  followed this module's raw-SQL convention instead, for consistency
  with the rest of `service.ts`).
- **Currency resolution priority order**, implemented in
  `resolveCurrency()`: explicit `currency` field first, then
  card-name mapping (`detectCurrencyFromCard`, substring match against
  `DEFAULT_CARD_CURRENCY_MAP`), then a regex scan of
  `note`+`merchant` text (`detectCurrencyFromText` — matches `RM`/`MYR`,
  `USD`/`US$`/bare `$` digit, `SGD`/`S$`), defaulting to `SGD` if
  nothing matches. This differs slightly from the task doc's stated
  order (which put "merchant context" before "explicit text") because
  in practice the explicit-currency regex and the merchant-context
  regex are the same text scan — there was no separate signal to order
  independently.
- **Maybank → MYR mapping was never added.** The task doc's example
  currency-detection acceptance criterion ("Maybank = MYR") is
  explicitly unmet: `DEFAULT_CARD_CURRENCY_MAP` in
  `src/config/currencies.ts` has entries for `OCBC`, `DBS`, `UOB` →
  `SGD` and `Crypto.com`/`Binance`/`Gemini` → `USD`, but no `Maybank`
  key. A transaction tagged with a Maybank card and no explicit
  currency falls through to the text-regex check and then to the
  `SGD` default — silently wrong for an MYR-denominated Maybank
  transaction unless the merchant/note text happens to mention `RM`.
  Tracked as a known gap, not fixed here.
- **AI categorization, not keyword rules**, via `inferCategory()` in
  `categorizer.ts` — a Gemini call with a system instruction listing
  all 10 categories and Singapore/Malaysia-specific guidance (hawker
  centers, kopi, mamak, Grab, MRT, FairPrice, etc.). Falls back to
  `'Others'` on any failure (empty input, unparseable response, thrown
  error) rather than surfacing an error to the caller — categorization
  failure should never block logging a transaction. `normalizeCategoryName()`
  is exported separately since `ai.ts`'s budget intent (once wired)
  needed the same case-insensitive category-name-to-enum matching
  without going through a full Gemini call.
- **Exchange rates stay static for this module.** `src/config/exchange-rates.ts`'s
  async, cached `getExchangeRates()` (built in PLUTO-01) is not called
  anywhere in `service.ts` — `toSGD()` from `src/config/currencies.ts`
  (synchronous, static `EXCHANGE_RATES` table) is used throughout,
  because `logExpense` and friends aren't `async`-blocked on a network
  call by design (categorization already is one Gemini round-trip per
  expense; adding a second external call for currency would slow every
  write). Revisit once/if live rates matter enough to justify the
  latency.
- **Recurring transactions fire via `node-cron`, once daily, with
  startup catch-up.** `src/scheduler/recurring.ts` schedules
  `fireRecurringForToday()` at `00:00` local time; `src/index.ts` also
  calls `triggerRecurringNow()` once on boot so a transaction due
  during downtime (app was off at midnight) still fires that day
  instead of being silently skipped. There's no catch-up for days
  further in the past than "today" — a recurring transaction is keyed
  only by `day_of_month`, not a last-fired timestamp, so if the app is
  down across an entire scheduled day, that occurrence is lost, not
  backfilled.
- **Recurring CRUD exists with no way to reach it.** `createRecurring`,
  `pauseRecurring`, `removeRecurring`, `listRecurring` are all
  implemented and exported, but there is no bot command or chat intent
  that calls any of them — a user can have recurring transactions fire
  automatically but currently cannot create, list, pause, or remove
  one without writing to the database directly. Tracked as an open gap
  in the task doc's acceptance criteria.
- **Corrections only ever touch the single most recent transaction.**
  `correctLastTransaction(field, value)` always operates on
  `SELECT * FROM transactions ORDER BY created_at DESC LIMIT 1` — there
  is no way to target an arbitrary past transaction by id or search.
  This matches the task doc's example ("last one was transport not
  food") and keeps the natural-language correction flow simple, at the
  cost of not supporting "actually, the one before that."
- **Category transaction counts added later, for the digest.**
  `SpendingSummary.byCategoryCount: Record<string, number>` was added
  after this module's initial build, once PLUTO-06 (daily digest)
  needed a per-category transaction count that `byCategory` (amounts
  only) didn't carry. Computed in the same loop `getSpendingSummary`
  already ran over all rows — additive, no behavior change for
  existing callers (`/today`, `/month`).
- **`getRecurringFiredToday` added later, also for the digest.** A
  read-only query (`source = 'recurring' AND created_at >= startOfToday`)
  added so the digest could report what auto-fired today without
  calling `fireRecurringForToday()` a second time (which would have
  double-logged, since that function always inserts).

## Module layout

```
src/expense/
├── index.ts                  # Public API barrel
├── service.ts                 # All transaction/recurring CRUD + queries (raw better-sqlite3)
├── categorizer.ts             # inferCategory (Gemini), normalizeCategoryName
├── currency-resolver.ts       # resolveCurrency, detectCurrencyFromCard/Text, parseExplicitCurrency
├── types.ts                    # ExpenseInput, RecurringInput, SpendingSummary, Comparison
└── expense.test.ts             # node:test suite, scratch DB per run

src/scheduler/
├── recurring.ts                 # startRecurringScheduler/triggerRecurringNow (node-cron)
└── recurring.test.ts             # Tests for deliverBudgetAlerts (added once PLUTO-05 existed)
```

### `service.ts` — key functions

```typescript
logExpense(data: ExpenseInput): Promise<Transaction>
undoLastTransaction(): Promise<Transaction | null>
correctLastTransaction(field: string, value: string): Promise<Transaction | null>

getSpendingSummary(period: SpendingPeriod): Promise<SpendingSummary>
getSpendingByCategory(period: SpendingPeriod): Promise<{ category: string; total: number }[]>
getTopExpenses(period: SpendingPeriod, limit?: number): Promise<Transaction[]>
compareSpending(period1: SpendingPeriod, period2: SpendingPeriod): Promise<Comparison>

createRecurring(data: RecurringInput): Promise<RecurringTransaction & { is_active: boolean }>
pauseRecurring(id: string): Promise<void>
removeRecurring(id: string): Promise<void>
listRecurring(): Promise<RecurringTransaction[]>
fireRecurringForToday(): Promise<Transaction[]>
getRecurringFiredToday(): Promise<Transaction[]>

exportCSV(year: number): Promise<string> // returns file path under ./data/exports/
```

Every function follows the same shape: `getSQLiteDb()` opens a fresh
connection (creating `./data` if needed — tables themselves come from
Drizzle migrations, not this module), runs one or more prepared
statements, maps rows to typed objects via `mapTransactionRow()`, and
`db.close()`s before returning. `logExpense` is the richest: resolves
currency → infers category (Gemini) → converts to SGD cents via
`toSGD` → inserts → re-selects the inserted row to return a fully
normalized `Transaction`.

`SpendingPeriod` is `'today' | 'week' | 'month'`; `startOfPeriod()`
computes the boundary timestamp for each (today = midnight local time;
week = 6 days back from today at midnight; month = the 1st of the
current month at midnight) — all in the process's local timezone (see
`README.md`'s note that `TZ=Asia/Singapore` must be set so these
boundaries line up with the digest's 10pm SGT schedule).

### `categorizer.ts`

```typescript
normalizeCategoryName(rawCategory: string): Category
inferCategory(input: { merchant?: string; note?: string; amount?: number }): Promise<Category>
```

`inferCategory` short-circuits to `'Others'` if both `merchant` and
`note` are empty; otherwise calls Gemini
(`gemini-3.6-flash`, same model id as `ai.ts`) with a system
instruction listing all 10 categories and Singapore/Malaysia examples,
parses the JSON response the same defensive way as `ai.ts`
(`safeJsonParse` on the outermost `{...}` span), and normalizes the
returned category name against the fixed list — falling back to
`'Others'` on any parse failure, missing category, or thrown error
(network, timeout — no explicit timeout race here, unlike `ai.ts`'s
classification call).

### `currency-resolver.ts`

```typescript
detectCurrencyFromCard(cardName?: string): Currency | undefined
detectCurrencyFromText(text?: string): Currency | undefined
resolveCurrency(input: { currency?; cardName?; merchant?; note? }): Currency
parseExplicitCurrency(text?: string): Currency | undefined // used by the webhook (PLUTO-07)
```

`parseExplicitCurrency` is a separate, narrower helper (checks
`RM`/`MYR` → `MYR`, `SGD`/`S$` → `SGD`, `USD`/`US$`/bare `$` → `USD`)
from `detectCurrencyFromText` — added specifically for the iOS
Shortcut webhook's amount-string parsing (e.g. `"RM 45.00"`), which
needed to treat a currency prefix on the *amount* field itself as an
override, distinct from scanning merchant/note free text.

### `types.ts`

```typescript
type ExpenseSource = 'apple_pay' | 'text' | 'voice';
type SpendingPeriod = 'today' | 'week' | 'month';

interface ExpenseInput { amount: number; currency?: Currency; merchant?: string; cardName?: string; note?: string; source: ExpenseSource | string; }
interface RecurringInput { amount: number; currency?: Currency; merchant: string; category?: Category; day_of_month: number; is_active?: boolean; }
interface SpendingSummary { period: SpendingPeriod; total: number; count: number; byCategory: Record<string, number>; byCategoryCount: Record<string, number>; topExpenses: Transaction[]; }
interface Comparison { period1: SpendingSummary; period2: SpendingSummary; delta: number; }
```

### `src/scheduler/recurring.ts`

```typescript
startRecurringScheduler(bot: Bot | null): void   // cron '0 0 * * *' -> fireRecurringForToday()
stopRecurringScheduler(): void
triggerRecurringNow(bot: Bot | null): Promise<void>  // manual trigger, also used for startup catch-up
```

At this module's initial build, `startRecurringScheduler`/
`triggerRecurringNow` took no `bot` parameter and only called
`fireRecurringForToday()`, logging the result. The `bot: Bot | null`
parameter and the `deliverBudgetAlerts` call after firing were added
once PLUTO-05 (budget system) needed to push threshold alerts for
transactions the scheduler creates — see that module's design doc for
the alert-delivery details; this module still owns firing the
transactions themselves.

## Data model

No new tables — this module is the primary reader/writer of
`transactions` and `recurring_transactions`, both defined in PLUTO-01's
`src/db/schema.ts`. All monetary columns are integer cents; `amount_sgd`
is always the SGD-normalized value regardless of the transaction's
original currency, used by every summary/aggregation function so
cross-currency spending totals never need to re-convert at read time.

## Wiring into the rest of the app

- `src/bot/commands/{today,month,export,undo}.ts` call
  `getSpendingSummary`, `exportCSV`, `undoLastTransaction` directly.
- `src/bot/ai.ts`'s `correction` case dynamically imports
  `correctLastTransaction`.
- `src/index.ts` calls `startRecurringScheduler(bot)` and, once on
  boot, `await triggerRecurringNow(bot)` for startup catch-up.
- The free-text `expense` chat intent does **not** call `logExpense` —
  see PLUTO-02's design doc; this remains the single largest gap
  between what the bot can classify and what it can actually persist.
- The iOS Shortcut webhook (PLUTO-07) is the only other production
  caller of `logExpense`, passing `source: 'apple_pay'`.

## Testing

`src/expense/expense.test.ts` (registered in `package.json`'s `test`
script), deleting and recreating `./data/test-plutus.db` on each run,
calling `runMigrations()` in a `before()` hook:

- `logExpense` stores an SGD-normalized value and infers the correct
  category for local-context merchants (a Malaysian kopi tiam paid via
  a Maybank card → `Food`; a Grab ride via DBS Visa → `Transport`).
- `undoLastTransaction` removes the most recently inserted row and
  the running total decreases accordingly.
- A recurring transaction created for today's `day_of_month` is
  returned by `fireRecurringForToday()`.
- `getSpendingSummary` tracks a per-category transaction count
  (`byCategoryCount`) that sums back to the overall `count`.
- `getRecurringFiredToday` returns already-fired recurring
  transactions without inserting anything new (called twice, same
  result both times).

`src/scheduler/recurring.test.ts` — added once PLUTO-05 needed alert
delivery tested (`deliverBudgetAlerts` behavior); firing itself
(`fireRecurringForToday`) is covered by `expense.test.ts` instead of
duplicated here.

## Out of scope

- Maybank → MYR in `DEFAULT_CARD_CURRENCY_MAP` — flagged, not fixed.
- Any bot command or chat flow for recurring transaction management
  (create/pause/remove/list) — the service functions exist; nothing
  calls them from the user-facing surface.
- Live/cached exchange rates — `toSGD` uses the static table from
  PLUTO-01; `src/config/exchange-rates.ts`'s async path is unused here.
- Wiring the free-text `expense` intent to `logExpense` — a PLUTO-02
  gap this module doesn't close (the expense engine exposes everything
  needed; nothing calls it from `ai.ts`'s `expense` case).
- A general free-form spending search (`queries/search.ts` in the
  original task doc's file list) — not built; `getSpendingSummary`/
  `getSpendingByCategory`/`getTopExpenses`/`compareSpending` cover the
  aggregations actually needed by the bot commands and the digest.
