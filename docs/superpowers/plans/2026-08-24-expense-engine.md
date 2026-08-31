# Expense Engine (PLUTO-03) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking — this plan is retrospective, documenting work already completed, so every step is checked off.

**Goal:** Build the transaction engine that logs expenses from any input channel, categorizes them via Gemini, resolves and converts currency to SGD, supports undo/correction of the most recent transaction, answers spending queries, and auto-fires recurring transactions on schedule.

**Architecture:** `src/expense/service.ts` is a single file where every exported function opens its own raw `better-sqlite3` connection, runs hand-written SQL against the `transactions`/`recurring_transactions` tables (already migrated by PLUTO-01's Drizzle setup), and closes the connection before returning — a deliberate second persistence style alongside PLUTO-01's Drizzle singleton, chosen for direct control over the aggregation SQL this module needs. `categorizer.ts` and `currency-resolver.ts` are pure(-ish) helpers `service.ts` calls into; `src/scheduler/recurring.ts` is a thin `node-cron` wrapper around `fireRecurringForToday()`.

**Tech Stack:** TypeScript, better-sqlite3 (raw driver, no ORM), `@google/generative-ai` (categorization), node-cron (recurring scheduler), node's built-in test runner.

**Spec:** [docs/superpowers/specs/2026-08-24-expense-engine-design.md](../specs/2026-08-24-expense-engine-design.md)

## Global Constraints

- All monetary amounts are stored and manipulated as integer cents — never floats. `amount_sgd` is always the SGD-normalized value, computed via `toSGD` from `src/config/currencies.ts` at write time, and is what every summary/aggregation function sums.
- This module does **not** use Drizzle or `src/db/client.ts` — every function in `service.ts` opens its own `better-sqlite3` connection via a local `getSQLiteDb()` helper and closes it before returning. If a column changes in `src/db/schema.ts`, the raw SQL strings here must be updated by hand to match.
- `Category` is the fixed 10-value union from `src/types/transaction.ts` — categorization must always resolve to one of these (falling back to `'Others'`), never a freeform string.
- `correctLastTransaction` and `undoLastTransaction` only ever operate on the single most recent transaction (`ORDER BY created_at DESC LIMIT 1`) — no arbitrary-transaction targeting.
- `fireRecurringForToday()` must be idempotent-safe to call multiple times a day only in the sense that it's driven by `day_of_month` matching — it does not itself dedupe multiple calls on the same day (calling it twice on the same `day_of_month` would double-log). Callers (the scheduler, startup catch-up) must not call it more than once per relevant day in normal operation.
- New test files must be registered in `package.json`'s `test` script.

---

## File Structure

```
src/expense/index.ts                (implemented) — public API barrel
src/expense/service.ts              (implemented) — all transaction/recurring CRUD + queries
src/expense/categorizer.ts          (implemented) — inferCategory (Gemini), normalizeCategoryName
src/expense/currency-resolver.ts    (implemented) — resolveCurrency, detectCurrencyFrom{Card,Text}, parseExplicitCurrency
src/expense/types.ts                 (implemented) — ExpenseInput, RecurringInput, SpendingSummary, Comparison
src/expense/expense.test.ts          (implemented)
src/scheduler/recurring.ts           (implemented) — node-cron wrapper, later gains bot/alert wiring (PLUTO-05)
src/scheduler/recurring.test.ts      (implemented) — added once PLUTO-05 needed alert-delivery tests
src/bot/commands/today.ts            (modified) — wired to getSpendingSummary
src/bot/commands/month.ts            (modified) — wired to getSpendingSummary
src/bot/commands/export.ts           (modified) — wired to exportCSV
src/bot/commands/undo.ts             (modified) — wired to undoLastTransaction
src/bot/ai.ts                        (modified) — correction case wired to correctLastTransaction
src/index.ts                         (modified) — starts the recurring scheduler + startup catch-up
src/types/transaction.ts             (modified) — minor Transaction shape adjustments
package.json                         (modified) — registers src/expense/expense.test.ts
```

---

### Task 1: Expense module types

**Files:** `src/expense/types.ts`

- [x] **Step 1: Define input/output shapes**

```typescript
export type ExpenseSource = 'apple_pay' | 'text' | 'voice';
export type SpendingPeriod = 'today' | 'week' | 'month';

export interface ExpenseInput {
  amount: number; currency?: Currency; merchant?: string;
  cardName?: string; note?: string; source: ExpenseSource | string;
}
export interface RecurringInput {
  amount: number; currency?: Currency; merchant: string;
  category?: Category; day_of_month: number; is_active?: boolean;
}
export interface SpendingSummary {
  period: SpendingPeriod; total: number; count: number;
  byCategory: Record<string, number>; topExpenses: Transaction[];
  // byCategoryCount added later, see Task 8
}
export interface Comparison { period1: SpendingSummary; period2: SpendingSummary; delta: number; }
```

---

### Task 2: Currency resolver

**Files:** `src/expense/currency-resolver.ts`

**Interfaces:**
- Produces: `detectCurrencyFromCard(cardName?): Currency | undefined`, `detectCurrencyFromText(text?): Currency | undefined`, `resolveCurrency(input): Currency`, `parseExplicitCurrency(text?): Currency | undefined`.

- [x] **Step 1: Card-based detection**

`detectCurrencyFromCard`: lowercase substring match of `cardName`
against the keys of `DEFAULT_CARD_CURRENCY_MAP` (from
`src/config/currencies.ts`); returns the mapped `Currency` or
`undefined` if no key matches.

- [x] **Step 2: Text-based detection**

`detectCurrencyFromText`: regex checks in priority order — `RM|MYR` →
`MYR`; `USD|US\$|\$\s?\d` → `USD`; `SGD|S\$` → `SGD`; a bare `$` digit
with none of the above present → `USD`. Returns `undefined` if nothing
matches.

- [x] **Step 3: `resolveCurrency` — the priority chain**

```typescript
export function resolveCurrency(input: { currency?; cardName?; merchant?; note? }): Currency {
  if (input.currency) return input.currency;
  const cardCurrency = detectCurrencyFromCard(input.cardName);
  if (cardCurrency) return cardCurrency;
  const explicit = detectCurrencyFromText(`${input.note ?? ''} ${input.merchant ?? ''}`);
  if (explicit) return explicit;
  return 'SGD';
}
```

- [x] **Step 4: `parseExplicitCurrency` — narrower helper for amount-string parsing**

A separate, stricter version used later by the iOS Shortcut webhook
(PLUTO-07) to detect a currency prefix on the raw amount string itself
(e.g. `"RM 45.00"`), distinct from scanning free-text merchant/note
fields.

- [x] **Step 5: Verify**

Manual + covered indirectly by `expense.test.ts`'s categorization
tests (which log transactions with explicit and card-derived
currencies and assert `amount_sgd > 0`).

---

### Task 3: AI categorizer

**Files:** `src/expense/categorizer.ts`

**Interfaces:**
- Produces: `normalizeCategoryName(raw: string): Category`, `inferCategory(input: { merchant?; note?; amount? }): Promise<Category>`.

- [x] **Step 1: Define the fixed category list and normalizer**

`VALID_CATEGORIES` (all 10, as a `readonly Category[]`);
`normalizeCategoryName` does a case-insensitive exact match against
that list, falling back to `'Others'`.

- [x] **Step 2: Implement `inferCategory`**

Short-circuits to `'Others'` if `merchant`+`note` are both empty.
Otherwise calls `GoogleGenerativeAI` with a system instruction listing
each category and Singapore/Malaysia-specific guidance (hawker
centers, kopi, mamak, Grab, MRT, FairPrice, Giant, Cold Storage, wet
markets, etc.), sends a prompt with merchant/note/formatted amount,
parses the JSON response the same defensive way as `ai.ts`
(`safeJsonParse` scanning for the outermost `{...}`), normalizes the
returned category, and logs the result. Any failure (parse, network,
thrown error) falls back to `'Others'` — categorization must never
block a transaction from being logged.

- [x] **Step 3: Verify**

Covered by `expense.test.ts`'s `logExpense` test (a Malaysian kopi
tiam transaction categorizes as `Food`; a Grab ride as `Transport`) —
this exercises a live Gemini call rather than stubbing it, since
`GOOGLE_API_KEY` is a required env var project-wide.

---

### Task 4: Transaction service — logging, undo, correction

**Files:** `src/expense/service.ts`

**Interfaces:**
- Consumes: `resolveCurrency` (Task 2), `inferCategory` (Task 3), `toSGD`/`config` (PLUTO-01).
- Produces: `logExpense(data): Promise<Transaction>`, `undoLastTransaction(): Promise<Transaction | null>`, `correctLastTransaction(field, value): Promise<Transaction | null>`.

- [x] **Step 1: Connection + mapping helpers**

`getSQLiteDb()`: ensures `./data` exists, opens a fresh
`better-sqlite3` connection (tables already exist via Drizzle
migrations — this function does not create them). `centsFromAmount`,
`startOfPeriod(period)` (today/week/month boundary, local timezone),
`mapTransactionRow(row)` (raw SQLite row → typed `Transaction`, parsing
timestamps into `Date`s).

- [x] **Step 2: `logExpense`**

Resolve currency → default merchant to `'Unknown merchant'` if blank →
`inferCategory` → compute `amountSgd = toSGD(amountCents, currency)` →
`INSERT INTO transactions (...)` → re-`SELECT` the inserted row by id
→ return the mapped `Transaction`.

- [x] **Step 3: `undoLastTransaction`**

`SELECT ... ORDER BY created_at DESC LIMIT 1`; if none, return `null`;
otherwise `DELETE ... WHERE id = ?` and return the now-deleted row's
mapped shape.

- [x] **Step 4: `correctLastTransaction(field, value)`**

Selects the most recent transaction; builds an `UPDATE` dynamically
based on `field` (`merchant` → direct replace; `category` → re-run
`inferCategory` using the row's existing merchant plus `value` as the
note, so a correction like "not food" gets categorized properly rather
than storing the literal string as a category; `note` → direct
replace; `amount` → recompute cents + `amount_sgd` using the row's
existing resolved currency; `currency` → re-resolve and recompute
`amount_sgd`); always bumps `updated_at`. Returns `null` if there's no
transaction to correct.

- [x] **Step 5: Verify**

Covered by `expense.test.ts` (`logExpense`, `undoLastTransaction`) and
by `src/bot/ai.test.ts` (correction wired through `buildAssistantReply`,
added in PLUTO-02's Task 5/6 once this function existed).

---

### Task 5: Spending queries

**Files:** `src/expense/service.ts` (continued)

**Interfaces:**
- Produces: `getSpendingSummary(period)`, `getSpendingByCategory(period)`, `getTopExpenses(period, limit?)`, `compareSpending(period1, period2)`.

- [x] **Step 1: `getSpendingSummary`**

Selects all rows with `created_at >= startOfPeriod(period)`, reduces
into `total` (sum of `amount_sgd`), `count`, and `byCategory` (sum per
category), plus `topExpenses` (first 5 rows by recency).

- [x] **Step 2: `getSpendingByCategory`**

Thin wrapper: calls `getSpendingSummary(period)` and maps
`byCategory` into a `{ category, total }[]` array — built specifically
so the (future) budget module could consume per-category totals
without duplicating the aggregation query.

- [x] **Step 3: `getTopExpenses` and `compareSpending`**

`getTopExpenses`: direct query, `ORDER BY created_at DESC LIMIT ?`.
`compareSpending`: runs `getSpendingSummary` for both periods and
returns their `delta` (`period1.total - period2.total`).

- [x] **Step 4: Wire `/today` and `/month` commands**

`src/bot/commands/today.ts`/`month.ts`: call `getSpendingSummary('today'
| 'month')`, format `total`/`count`/`byCategory` into the reply string
— replacing the placeholder strings from PLUTO-02's initial scaffold.

- [x] **Step 5: Verify**

`expense.test.ts`: logging two transactions and checking
`getSpendingSummary('month').total > 0` and that at least one category
bucket reflects the logged categories.

---

### Task 6: Recurring transactions — CRUD and firing

**Files:** `src/expense/service.ts` (continued), `src/scheduler/recurring.ts`

**Interfaces:**
- Produces: `createRecurring(data)`, `pauseRecurring(id)`, `removeRecurring(id)`, `listRecurring()`, `fireRecurringForToday(): Promise<Transaction[]>`; `startRecurringScheduler(): void`, `stopRecurringScheduler(): void`, `triggerRecurringNow(): Promise<void>` (both without the `bot` parameter at this stage — added later by PLUTO-05).

- [x] **Step 1: CRUD**

`createRecurring`: infers a category via `inferCategory` if none
given, inserts into `recurring_transactions`, returns the row with
`is_active` coerced to boolean and timestamps to `Date`s.
`pauseRecurring`/`removeRecurring`: direct `UPDATE`/`DELETE` by id.
`listRecurring`: all rows, ordered by `day_of_month`.

- [x] **Step 2: `fireRecurringForToday`**

Selects all `is_active = 1` rows where `day_of_month = <today's day>`;
for each, computes `amount_sgd` via `toSGD`, inserts a new
`transactions` row with `source = 'recurring'`, `card_name = 'Recurring'`,
and a note like `"Auto-logged recurring: {merchant}"`; collects and
returns every inserted `Transaction`.

- [x] **Step 3: Scheduler**

`src/scheduler/recurring.ts`: `node-cron` job at `'0 0 * * *'` (midnight
local time) calling `fireRecurringForToday()` and logging the result;
`triggerRecurringNow()` is the same call, exposed for manual/startup
use; `stopRecurringScheduler()` for clean shutdown/testing.

- [x] **Step 4: Wire into `src/index.ts`**

`startRecurringScheduler()` called on boot; `await triggerRecurringNow()`
also called once on boot, to catch up on any transaction whose
scheduled day already passed while the app was down (partial coverage
— see spec's scope decision on catch-up limits).

- [x] **Step 5: Verify**

`expense.test.ts`: create a recurring transaction with today's
`day_of_month`, call `fireRecurringForToday()`, assert the created
transaction includes it. No dedicated scheduler test yet at this
stage — added once PLUTO-05 needed to test `deliverBudgetAlerts`.

---

### Task 7: CSV export

**Files:** `src/expense/service.ts` (continued)

**Interfaces:**
- Produces: `exportCSV(year: number): Promise<string>`.

- [x] **Step 1: Implement**

Query all transactions in `[Jan 1 year, Jan 1 year+1)`; write a header
row plus one row per transaction (id, amount, currency, amount_sgd,
merchant, category, source, card_name, note, created_at), each field
quoted and internal quotes escaped; write to
`./data/exports/expenses-{year}.csv` (directory created if needed);
return the file path.

- [x] **Step 2: Wire `/export` command**

`src/bot/commands/export.ts`: `exportCSV(new Date().getFullYear())`,
reply with the file path — replacing PLUTO-02's placeholder.

---

### Task 8: Public API barrel and expense test suite

**Files:** `src/expense/index.ts`, `src/expense/expense.test.ts`, `package.json`

- [x] **Step 1: `index.ts`**

```typescript
export * from './types';
export * from './categorizer';
export * from './currency-resolver';
export { compareSpending, correctLastTransaction, createRecurring, exportCSV, fireRecurringForToday, getSpendingByCategory, getSpendingSummary, getTopExpenses, listRecurring, logExpense, pauseRecurring, removeRecurring, undoLastTransaction } from './service';
```

*(`getRecurringFiredToday` was added to this export list later — see Task 9.)*

- [x] **Step 2: Write `expense.test.ts`**

`process.env.DATABASE_URL = './data/test-plutus.db'`, delete any stale
file at that path, `before()` hook calls `runMigrations()`. Tests:
`logExpense` stores SGD-normalized value and detects local categories
(Maybank-carded kopi tiam → `Food`, DBS-carded Grab ride → `Transport`);
`undoLastTransaction` removes the most recent entry; a recurring
transaction fires for today.

- [x] **Step 3: Register and run**

`package.json`'s `test` script gains `src/expense/expense.test.ts`.
Run: `npx tsx --test src/expense/expense.test.ts` — passes.

---

### Task 9: Category transaction counts and read-only recurring query (for the digest, PLUTO-06)

*(Added after this module's initial build, once PLUTO-06 needed both — documented here since they live in this module's files.)*

**Files:** `src/expense/types.ts`, `src/expense/service.ts`, `src/expense/index.ts`, `src/expense/expense.test.ts`

- [x] **Step 1: `SpendingSummary.byCategoryCount`**

Added `byCategoryCount: Record<string, number>` to the interface;
`getSpendingSummary` now tracks a per-category count in the same loop
that builds `byCategory`, additive and non-breaking for existing
callers.

- [x] **Step 2: `getRecurringFiredToday`**

```typescript
export async function getRecurringFiredToday(): Promise<Transaction[]> {
  // SELECT * FROM transactions WHERE source = 'recurring' AND created_at >= startOfPeriod('today')
}
```

Read-only — does not call `fireRecurringForToday()` — so the digest
can report today's auto-logged transactions without double-firing
them (the midnight scheduler already fires them once).

- [x] **Step 3: Export and test**

Added to `src/expense/index.ts`'s export list. Tests added to
`expense.test.ts`: `byCategoryCount` sums back to `count`;
`getRecurringFiredToday` called twice returns the same result both
times (no growth from the read itself).

- [x] **Step 4: Verify**

Run: `npx tsx --test src/expense/expense.test.ts` — all tests,
including the two new ones, pass.
