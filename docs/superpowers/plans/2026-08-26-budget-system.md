# Budget System (PLUTO-05) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user set monthly spending budgets per category via chat or `/budget`, see live progress against them, and get a one-time Telegram alert at 80% and 100% of a budget.

**Architecture:** A new `src/budget/` module (types, Drizzle-based CRUD, live progress calculation, pure alert-detection) sits alongside the existing expense engine, consuming `getSpendingByCategory` from it. The `/budget` command and the free-text `budget` chat intent call into this module directly. Alert delivery is wired into the recurring-transaction scheduler — the only place transactions are currently created in production — via a small testable `deliverBudgetAlerts` helper that takes a grammy `Api` and sends a Telegram message when `checkAlerts` returns non-null.

**Tech Stack:** TypeScript, Drizzle ORM (`drizzle-orm/better-sqlite3`), better-sqlite3, grammy, node:test.

**Spec:** [docs/superpowers/specs/2026-08-26-budget-system-design.md](../specs/2026-08-26-budget-system-design.md)

## Global Constraints

- All monetary amounts are stored as integer cents, never floats.
- `Category` is the fixed union in `src/types/transaction.ts` (`Food | Transport | Shopping | Entertainment | Bills | Health | Education | Travel | Groceries | Others`) — no new categories.
- Budgets are monthly only in V1 — no weekly/custom periods, no explicit reset job (progress is always computed live from the current month's transactions; alert dedup rows are keyed by `'YYYY-MM'`, so a new month naturally re-arms both thresholds).
- Currency conversion uses the existing static-rate `toSGD` from `src/config/currencies.ts` — no live rates.
- The new budget module uses the Drizzle query builder (`db` from `src/db/client.ts` / `src/db`), not the expense module's raw-`better-sqlite3` pattern. Do not modify `src/expense/service.ts`'s persistence style.
- New test files must be added to the `test` script in `package.json` or they will not run under `npm test`.
- Test files that touch the database must set `process.env.DATABASE_URL` to a dedicated, non-shared test db path *before* importing anything that transitively loads `src/config/env.ts`, delete any stale file at that path, then call `runMigrations()` from `src/db/migrate.ts` in a `before()` hook — this is the existing pattern in `src/expense/expense.test.ts`.

---

## File Structure

```
src/db/schema.ts                        # modify: add budget_alerts table
src/db/migrations/                      # generated: new migration for budget_alerts

src/budget/
├── index.ts                            # create: public exports
├── types.ts                            # create: Budget, BudgetStatus, Alert
├── service.ts                          # create: setBudget, removeBudget, listBudgets, findBudgetByCategory
├── service.test.ts                     # create
├── progress.ts                         # create: getBudgetStatus
├── progress.test.ts                    # create
├── alerts.ts                           # create: checkAlerts
└── alerts.test.ts                      # create

src/bot/commands/budget.ts              # modify: real /budget command
src/bot/ai.ts                           # modify: wire 'budget' intent to real service calls
src/bot/ai.test.ts                      # modify: add tests for the new 'budget' intent behavior

src/scheduler/recurring.ts              # modify: thread a Bot/Api through, deliver alerts after firing
src/scheduler/recurring.test.ts         # create
src/index.ts                            # modify: pass the bot instance into the scheduler

package.json                            # modify: register new test files
doc/tasks/05-budget-system.md           # modify: check off acceptance criteria at the end
```

---

### Task 1: Schema — add `budget_alerts` table and generate migration

**Files:**
- Modify: `src/db/schema.ts`
- Generated: `src/db/migrations/*.sql` (new file, exact name assigned by drizzle-kit), `src/db/migrations/meta/*`

**Interfaces:**
- Produces: `budget_alerts` Drizzle table (`id`, `budget_id`, `threshold`, `month`, `sent_at`), importable as `import { budget_alerts } from '../db/schema'` or `from '../db'`.

- [ ] **Step 1: Add the table to the schema**

In `src/db/schema.ts`, immediately after the existing `budgets` table definition, add:

```typescript
// Budget alert dedup table — one row per (budget, threshold, month) once sent
export const budget_alerts = sqliteTable('budget_alerts', {
  id: text('id').primaryKey(),
  budget_id: text('budget_id')
    .notNull()
    .references(() => budgets.id),
  threshold: integer('threshold').notNull(), // 80 or 100
  month: text('month').notNull(), // 'YYYY-MM'
  sent_at: integer('sent_at')
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});
```

- [ ] **Step 2: Generate the migration**

Run: `npm run db:generate`

Expected: a new file appears under `src/db/migrations/` (e.g. `0001_<name>.sql`) containing `CREATE TABLE budget_alerts (...)`, and `src/db/migrations/meta/_journal.json` gains a new entry. Open the generated `.sql` file and confirm it creates `budget_alerts` with the five columns above and a foreign key on `budget_id`.

- [ ] **Step 3: Verify migrations apply cleanly**

Run: `npx tsx -e "import('./src/db/migrate').then(m => m.runMigrations())"`

Expected: logs "Migrations completed successfully!" with no errors. Migrations are idempotent (drizzle tracks applied ones in its own journal table), so this is safe to run against the existing dev db without deleting anything.

- [ ] **Step 4: Commit**

```bash
git add src/db/schema.ts src/db/migrations
git commit -m "feat(db): add budget_alerts table for budget threshold dedup"
```

---

### Task 2: Budget types and CRUD service

**Files:**
- Create: `src/budget/types.ts`
- Create: `src/budget/service.ts`
- Create: `src/budget/service.test.ts`
- Modify: `package.json` (test script)

**Interfaces:**
- Consumes: `db` from `../db` (Drizzle instance), `budgets` table from `../db` (from Task 1's `src/db/schema.ts`, already existed before this plan), `toSGD` from `../config` (existing, `src/config/currencies.ts`), `Category`/`Currency` from `../types` (existing).
- Produces:
  - `interface Budget { id: string; category: Category; amount: number; currency: Currency; amount_sgd: number; created_at: Date; updated_at: Date }`
  - `setBudget(category: Category, amount: number, currency?: Currency): Promise<Budget>`
  - `removeBudget(category: Category): Promise<void>`
  - `listBudgets(): Promise<Budget[]>`
  - `findBudgetByCategory(category: Category): Promise<Budget | null>` (used by Task 4's `alerts.ts`)

- [ ] **Step 1: Write `types.ts`**

```typescript
/**
 * Budget module types
 */

import { Category, Currency } from '../types';

export interface Budget {
  id: string;
  category: Category;
  amount: number; // cents, in original currency
  currency: Currency;
  amount_sgd: number; // cents, normalized to SGD
  created_at: Date;
  updated_at: Date;
}

export interface BudgetStatus {
  category: Category;
  budget_amount: number; // cents, original currency
  budget_currency: Currency;
  budget_sgd: number; // cents
  spent_sgd: number; // cents
  percentage: number; // spent_sgd / budget_sgd * 100, one decimal place
  remaining_sgd: number; // cents, can be negative when over budget
  days_left_in_month: number;
}

export interface Alert {
  budget_id: string;
  category: Category;
  threshold: 80 | 100;
  message: string;
}
```

- [ ] **Step 2: Write the failing test for `setBudget` (create + update)**

Create `src/budget/service.test.ts`:

```typescript
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

process.env.DATABASE_URL = './data/test-budget-service.db';

const testDbPath = path.resolve('./data/test-budget-service.db');
if (fs.existsSync(testDbPath)) {
  fs.rmSync(testDbPath, { force: true });
}

before(async () => {
  const { runMigrations } = await import('../db/migrate');
  runMigrations();
});

test('setBudget creates a new budget with cents/SGD conversion', async () => {
  const { setBudget } = await import('./service');
  const budget = await setBudget('Food', 800, 'SGD');

  assert.equal(budget.category, 'Food');
  assert.equal(budget.amount, 80000);
  assert.equal(budget.currency, 'SGD');
  assert.equal(budget.amount_sgd, 80000);
});

test('setBudget defaults to SGD when no currency is given', async () => {
  const { setBudget } = await import('./service');
  const budget = await setBudget('Entertainment', 50);

  assert.equal(budget.currency, 'SGD');
  assert.equal(budget.amount_sgd, 5000);
});

test('setBudget updates an existing budget for the same category instead of duplicating', async () => {
  const { setBudget, listBudgets } = await import('./service');
  await setBudget('Transport', 200, 'SGD');
  const updated = await setBudget('Transport', 300, 'SGD');

  const all = await listBudgets();
  const transportBudgets = all.filter((b) => b.category === 'Transport');

  assert.equal(transportBudgets.length, 1);
  assert.equal(updated.amount, 30000);
});

test('setBudget converts non-SGD currency using the static exchange rates', async () => {
  const { setBudget } = await import('./service');
  const budget = await setBudget('Shopping', 100, 'MYR');

  assert.equal(budget.amount, 10000);
  assert.equal(budget.currency, 'MYR');
  assert.ok(budget.amount_sgd > 0);
  assert.notEqual(budget.amount_sgd, budget.amount);
});

test('removeBudget deletes the budget row', async () => {
  const { setBudget, removeBudget, listBudgets } = await import('./service');
  await setBudget('Health', 100, 'SGD');
  await removeBudget('Health');

  const all = await listBudgets();
  assert.ok(!all.some((b) => b.category === 'Health'));
});

test('findBudgetByCategory returns null when no budget exists for that category', async () => {
  const { findBudgetByCategory } = await import('./service');
  const result = await findBudgetByCategory('Education');
  assert.equal(result, null);
});

test('findBudgetByCategory returns the budget when one exists', async () => {
  const { setBudget, findBudgetByCategory } = await import('./service');
  await setBudget('Groceries', 400, 'SGD');

  const found = await findBudgetByCategory('Groceries');
  assert.ok(found);
  assert.equal(found!.amount_sgd, 40000);
});
```

- [ ] **Step 3: Register the test file and run it to see it fail**

In `package.json`, update the `test` script to:

```json
"test": "npx tsx --test src/bot/ai.test.ts src/expense/expense.test.ts src/budget/service.test.ts",
```

Run: `npx tsx --test src/budget/service.test.ts`
Expected: FAIL — `Cannot find module './service'` (it doesn't exist yet).

- [ ] **Step 4: Write `service.ts`**

```typescript
/**
 * Budget CRUD service (Drizzle-backed).
 */

import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { budgets } from '../db/schema';
import { toSGD } from '../config';
import { Category, Currency } from '../types';
import { Budget } from './types';

function mapBudgetRow(row: typeof budgets.$inferSelect): Budget {
  return {
    id: row.id,
    category: row.category as Category,
    amount: row.amount,
    currency: row.currency as Currency,
    amount_sgd: row.amount_sgd,
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at),
  };
}

export async function setBudget(
  category: Category,
  amount: number,
  currency: Currency = 'SGD',
): Promise<Budget> {
  const amountCents = Math.max(0, Math.round(amount * 100));
  const amountSgd = toSGD(amountCents, currency);
  const now = Date.now();

  const existing = await db.select().from(budgets).where(eq(budgets.category, category)).get();

  if (existing) {
    const [updated] = await db
      .update(budgets)
      .set({ amount: amountCents, currency, amount_sgd: amountSgd, updated_at: now })
      .where(eq(budgets.id, existing.id))
      .returning();
    return mapBudgetRow(updated);
  }

  const [inserted] = await db
    .insert(budgets)
    .values({
      id: randomUUID(),
      category,
      amount: amountCents,
      currency,
      amount_sgd: amountSgd,
      period: 'monthly',
      created_at: now,
      updated_at: now,
    })
    .returning();

  return mapBudgetRow(inserted);
}

export async function removeBudget(category: Category): Promise<void> {
  await db.delete(budgets).where(eq(budgets.category, category));
}

export async function listBudgets(): Promise<Budget[]> {
  const rows = await db.select().from(budgets).orderBy(budgets.category);
  return rows.map(mapBudgetRow);
}

export async function findBudgetByCategory(category: Category): Promise<Budget | null> {
  const row = await db.select().from(budgets).where(eq(budgets.category, category)).get();
  return row ? mapBudgetRow(row) : null;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx tsx --test src/budget/service.test.ts`
Expected: PASS, all 7 tests green.

- [ ] **Step 6: Run the full suite to check for regressions**

Run: `npm test`
Expected: PASS (existing `ai.test.ts` and `expense.test.ts` tests unaffected).

- [ ] **Step 7: Commit**

```bash
git add src/budget/types.ts src/budget/service.ts src/budget/service.test.ts package.json
git commit -m "feat(budget): add budget CRUD service"
```

---

### Task 3: Progress calculator

**Files:**
- Create: `src/budget/progress.ts`
- Create: `src/budget/progress.test.ts`
- Modify: `package.json` (test script)

**Interfaces:**
- Consumes: `listBudgets` from `./service` (Task 2), `getSpendingByCategory(period: 'month'): Promise<{ category: string; total: number }[]>` from `../expense/service` (existing), `BudgetStatus` from `./types` (Task 2).
- Produces: `getBudgetStatus(): Promise<BudgetStatus[]>`

- [ ] **Step 1: Write the failing test**

Create `src/budget/progress.test.ts`:

```typescript
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.DATABASE_URL = './data/test-budget-progress.db';

const testDbPath = path.resolve('./data/test-budget-progress.db');
if (fs.existsSync(testDbPath)) {
  fs.rmSync(testDbPath, { force: true });
}

before(async () => {
  const { runMigrations } = await import('../db/migrate');
  runMigrations();
});

async function seedTransaction(category: string, amountSgdCents: number): Promise<void> {
  const { db, transactions } = await import('../db');
  const now = Date.now();
  await db.insert(transactions).values({
    id: randomUUID(),
    amount: amountSgdCents,
    currency: 'SGD',
    amount_sgd: amountSgdCents,
    merchant: 'Test merchant',
    category,
    source: 'text',
    card_name: 'Test',
    created_at: now,
    updated_at: now,
  });
}

test('getBudgetStatus computes percentage, remaining, and days left', async () => {
  const { setBudget } = await import('./service');
  const { getBudgetStatus } = await import('./progress');

  await setBudget('Food', 100, 'SGD'); // S$100 budget
  await seedTransaction('Food', 4000); // S$40 spent

  const statuses = await getBudgetStatus();
  const food = statuses.find((s) => s.category === 'Food');

  assert.ok(food);
  assert.equal(food!.budget_sgd, 10000);
  assert.equal(food!.spent_sgd, 4000);
  assert.equal(food!.percentage, 40);
  assert.equal(food!.remaining_sgd, 6000);

  const now = new Date();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  assert.equal(food!.days_left_in_month, daysInMonth - now.getDate());
});

test('getBudgetStatus reports zero spend for a category with a budget but no transactions', async () => {
  const { setBudget } = await import('./service');
  const { getBudgetStatus } = await import('./progress');

  await setBudget('Education', 50, 'SGD');

  const statuses = await getBudgetStatus();
  const education = statuses.find((s) => s.category === 'Education');

  assert.ok(education);
  assert.equal(education!.spent_sgd, 0);
  assert.equal(education!.percentage, 0);
});
```

- [ ] **Step 2: Register the test file and run it to see it fail**

In `package.json`, update the `test` script to:

```json
"test": "npx tsx --test src/bot/ai.test.ts src/expense/expense.test.ts src/budget/service.test.ts src/budget/progress.test.ts",
```

Run: `npx tsx --test src/budget/progress.test.ts`
Expected: FAIL — `Cannot find module './progress'`.

- [ ] **Step 3: Write `progress.ts`**

```typescript
/**
 * Budget progress calculator — current month spend vs each budget.
 */

import { getSpendingByCategory } from '../expense/service';
import { listBudgets } from './service';
import { BudgetStatus } from './types';

function daysLeftInMonth(now: Date): number {
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  return daysInMonth - now.getDate();
}

export async function getBudgetStatus(): Promise<BudgetStatus[]> {
  const [budgets, spending] = await Promise.all([listBudgets(), getSpendingByCategory('month')]);
  const spendByCategory = new Map(spending.map((entry) => [entry.category, entry.total]));
  const daysLeft = daysLeftInMonth(new Date());

  return budgets.map((budget) => {
    const spentSgd = spendByCategory.get(budget.category) ?? 0;
    const percentage =
      budget.amount_sgd > 0 ? Math.round((spentSgd / budget.amount_sgd) * 1000) / 10 : 0;

    return {
      category: budget.category,
      budget_amount: budget.amount,
      budget_currency: budget.currency,
      budget_sgd: budget.amount_sgd,
      spent_sgd: spentSgd,
      percentage,
      remaining_sgd: budget.amount_sgd - spentSgd,
      days_left_in_month: daysLeft,
    };
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test src/budget/progress.test.ts`
Expected: PASS, both tests green.

- [ ] **Step 5: Run the full suite to check for regressions**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/budget/progress.ts src/budget/progress.test.ts package.json
git commit -m "feat(budget): add live budget progress calculation"
```

---

### Task 4: Alert checker

**Files:**
- Create: `src/budget/alerts.ts`
- Create: `src/budget/alerts.test.ts`
- Modify: `package.json` (test script)

**Interfaces:**
- Consumes: `findBudgetByCategory` from `./service` (Task 2), `getSpendingByCategory` from `../expense/service` (existing), `Transaction` from `../types` (existing), `budget_alerts` table from `../db` (Task 1), `Alert` from `./types` (Task 2).
- Produces: `checkAlerts(transaction: Transaction): Promise<Alert | null>`

- [ ] **Step 1: Write the failing test**

Create `src/budget/alerts.test.ts`:

```typescript
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.DATABASE_URL = './data/test-budget-alerts.db';

const testDbPath = path.resolve('./data/test-budget-alerts.db');
if (fs.existsSync(testDbPath)) {
  fs.rmSync(testDbPath, { force: true });
}

before(async () => {
  const { runMigrations } = await import('../db/migrate');
  runMigrations();
});

async function insertTransaction(category: string, amountSgdCents: number) {
  const { db, transactions } = await import('../db');
  const now = Date.now();
  const id = randomUUID();

  await db.insert(transactions).values({
    id,
    amount: amountSgdCents,
    currency: 'SGD',
    amount_sgd: amountSgdCents,
    merchant: 'Test merchant',
    category,
    source: 'text',
    card_name: 'Test',
    created_at: now,
    updated_at: now,
  });

  return {
    id,
    amount: amountSgdCents,
    currency: 'SGD' as const,
    amount_sgd: amountSgdCents,
    merchant: 'Test merchant',
    category: category as any,
    source: 'text',
    card_name: 'Test',
    created_at: new Date(now),
    updated_at: new Date(now),
  };
}

test('checkAlerts returns null when there is no budget for the category', async () => {
  const { checkAlerts } = await import('./alerts');
  const txn = await insertTransaction('Travel', 1000);

  const alert = await checkAlerts(txn);
  assert.equal(alert, null);
});

test('checkAlerts fires once at 80% and not again for a later transaction under 100%', async () => {
  const { setBudget } = await import('./service');
  const { checkAlerts } = await import('./alerts');

  await setBudget('Food', 100, 'SGD'); // S$100 budget

  const first = await insertTransaction('Food', 8500); // 85%
  const firstAlert = await checkAlerts(first);
  assert.ok(firstAlert);
  assert.equal(firstAlert!.threshold, 80);

  const second = await insertTransaction('Food', 100); // 86%, still under 100%
  const secondAlert = await checkAlerts(second);
  assert.equal(secondAlert, null);
});

test('checkAlerts fires the 100% alert once when spend crosses it', async () => {
  const { setBudget } = await import('./service');
  const { checkAlerts } = await import('./alerts');

  await setBudget('Shopping', 100, 'SGD');

  const pushOver = await insertTransaction('Shopping', 10500); // 105%
  const alert = await checkAlerts(pushOver);
  assert.ok(alert);
  assert.equal(alert!.threshold, 100);

  const again = await insertTransaction('Shopping', 100);
  const repeat = await checkAlerts(again);
  assert.equal(repeat, null);
});

test('checkAlerts re-fires in a new month even if already sent in a previous month', async () => {
  const { setBudget, findBudgetByCategory } = await import('./service');
  const { checkAlerts } = await import('./alerts');
  const { db } = await import('../db');
  const { budget_alerts } = await import('../db/schema');

  await setBudget('Bills', 100, 'SGD');
  const budget = await findBudgetByCategory('Bills');
  assert.ok(budget);

  await db.insert(budget_alerts).values({
    id: randomUUID(),
    budget_id: budget!.id,
    threshold: 80,
    month: '2000-01',
    sent_at: Date.now(),
  });

  const txn = await insertTransaction('Bills', 8500);
  const alert = await checkAlerts(txn);

  assert.ok(alert);
  assert.equal(alert!.threshold, 80);
});
```

- [ ] **Step 2: Register the test file and run it to see it fail**

In `package.json`, update the `test` script to:

```json
"test": "npx tsx --test src/bot/ai.test.ts src/expense/expense.test.ts src/budget/service.test.ts src/budget/progress.test.ts src/budget/alerts.test.ts",
```

Run: `npx tsx --test src/budget/alerts.test.ts`
Expected: FAIL — `Cannot find module './alerts'`.

- [ ] **Step 3: Write `alerts.ts`**

```typescript
/**
 * Budget alert detection. Pure w.r.t. delivery — returns alert data,
 * does not know about Telegram. See src/scheduler/recurring.ts for delivery.
 */

import { randomUUID } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { budget_alerts } from '../db/schema';
import { Transaction } from '../types';
import { getSpendingByCategory } from '../expense/service';
import { findBudgetByCategory } from './service';
import { Alert } from './types';

function currentMonthKey(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

async function markAlertSent(budgetId: string, threshold: 80 | 100, month: string): Promise<boolean> {
  const existing = await db
    .select()
    .from(budget_alerts)
    .where(
      and(
        eq(budget_alerts.budget_id, budgetId),
        eq(budget_alerts.threshold, threshold),
        eq(budget_alerts.month, month),
      ),
    );

  if (existing.length > 0) {
    return false;
  }

  await db.insert(budget_alerts).values({
    id: randomUUID(),
    budget_id: budgetId,
    threshold,
    month,
    sent_at: Date.now(),
  });

  return true;
}

function formatAlertMessage(category: string, threshold: 80 | 100, spentSgd: number, budgetSgd: number): string {
  const spent = (spentSgd / 100).toFixed(2);
  const limit = (budgetSgd / 100).toFixed(2);
  const icon = threshold === 100 ? '🚨' : '⚠️';
  const verb = threshold === 100 ? 'hit' : 'used';
  return `${icon} ${category} budget alert: you've ${verb} ${threshold}% (S$${spent} / S$${limit}) this month.`;
}

export async function checkAlerts(transaction: Transaction): Promise<Alert | null> {
  const budget = await findBudgetByCategory(transaction.category);
  if (!budget || budget.amount_sgd <= 0) {
    return null;
  }

  const spending = await getSpendingByCategory('month');
  const spentSgd = spending.find((entry) => entry.category === transaction.category)?.total ?? 0;
  const percentage = (spentSgd / budget.amount_sgd) * 100;
  const month = currentMonthKey();

  if (percentage >= 100) {
    const fired = await markAlertSent(budget.id, 100, month);
    await markAlertSent(budget.id, 80, month);
    if (!fired) {
      return null;
    }
    return {
      budget_id: budget.id,
      category: budget.category,
      threshold: 100,
      message: formatAlertMessage(budget.category, 100, spentSgd, budget.amount_sgd),
    };
  }

  if (percentage >= 80) {
    const fired = await markAlertSent(budget.id, 80, month);
    if (!fired) {
      return null;
    }
    return {
      budget_id: budget.id,
      category: budget.category,
      threshold: 80,
      message: formatAlertMessage(budget.category, 80, spentSgd, budget.amount_sgd),
    };
  }

  return null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test src/budget/alerts.test.ts`
Expected: PASS, all 4 tests green.

- [ ] **Step 5: Run the full suite to check for regressions**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/budget/alerts.ts src/budget/alerts.test.ts package.json
git commit -m "feat(budget): add threshold alert detection with monthly dedup"
```

---

### Task 5: Public module exports

**Files:**
- Create: `src/budget/index.ts`

**Interfaces:**
- Consumes: everything produced in Tasks 2–4.
- Produces: the module's public surface, importable as `from '../budget'` or `from '../../budget'`.

- [ ] **Step 1: Write `index.ts`**

```typescript
/**
 * Budget module public API.
 */

export * from './types';
export { setBudget, removeBudget, listBudgets, findBudgetByCategory } from './service';
export { getBudgetStatus } from './progress';
export { checkAlerts } from './alerts';
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/budget/index.ts
git commit -m "feat(budget): add public module exports"
```

---

### Task 6: `/budget` command

**Files:**
- Modify: `src/bot/commands/budget.ts`

**Interfaces:**
- Consumes: `getBudgetStatus` from `../../budget` (Task 5).
- Produces: `handleBudgetCommand(): Promise<string>` (signature unchanged — already wired into `src/bot/index.ts:62-65`).

- [ ] **Step 1: Replace the placeholder handler**

Replace the full contents of `src/bot/commands/budget.ts` with:

```typescript
/**
 * /budget command handler
 */

import { getBudgetStatus } from '../../budget';

export async function handleBudgetCommand(): Promise<string> {
  const statuses = await getBudgetStatus();

  if (statuses.length === 0) {
    return 'No budgets set yet. Try "Set food budget to $800/month" to create one.';
  }

  const lines = statuses.map((status) => {
    const spent = (status.spent_sgd / 100).toFixed(2);
    const limit = (status.budget_sgd / 100).toFixed(2);
    return `${status.category}: S$${spent} / S$${limit} (${status.percentage}%) — ${status.days_left_in_month} day(s) left`;
  });

  return `Budget status:\n${lines.join('\n')}`;
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Manual verification**

This handler has no dedicated test (matching the existing convention — `/today` and `/month` also have no command-level tests). Verify manually: run `npx tsx -e "
process.env.DATABASE_URL = './data/manual-check.db';
import('./src/db/migrate').then(async ({ runMigrations }) => {
  runMigrations();
  const { setBudget } = await import('./src/budget/service');
  await setBudget('Food', 100, 'SGD');
  const { handleBudgetCommand } = await import('./src/bot/commands/budget');
  console.log(await handleBudgetCommand());
});
"` and confirm it prints a "Budget status:" line for Food. Then `rm -f ./data/manual-check.db`.

- [ ] **Step 4: Commit**

```bash
git add src/bot/commands/budget.ts
git commit -m "feat(bot): wire /budget command to real budget status"
```

---

### Task 7: Wire the `budget` chat intent

**Files:**
- Modify: `src/bot/ai.ts` (the `case 'budget':` block inside `buildAssistantReply`, currently at lines 128-132)
- Modify: `src/bot/ai.test.ts`

**Interfaces:**
- Consumes: `setBudget`, `removeBudget` from `../budget/service` (Task 2), `normalizeCategoryName` from `../expense/categorizer` (existing).
- Produces: `buildAssistantReply`'s external signature is unchanged; its `'budget'` branch now performs real writes instead of returning a canned string.

- [ ] **Step 1: Write the failing tests**

In `src/bot/ai.test.ts`, add near the top (after the existing imports, before the first `test(...)`):

```typescript
process.env.DATABASE_URL = './data/test-ai-budget.db';

const aiTestDbPath = path.resolve('./data/test-ai-budget.db');
if (fs.existsSync(aiTestDbPath)) {
  fs.rmSync(aiTestDbPath, { force: true });
}

before(async () => {
  const { runMigrations } = await import('../db/migrate');
  runMigrations();
});
```

And add these two imports to the existing import block at the top of the file:

```typescript
import fs from 'node:fs';
import path from 'node:path';
```

And change the existing `import test from 'node:test';` line to:

```typescript
import test, { before } from 'node:test';
```

Then add these tests (anywhere after the other `test(...)` calls):

```typescript
test('buildAssistantReply sets a real budget for the budget intent', async () => {
  const reply = await buildAssistantReply({
    intent: 'budget',
    confidence: 0.9,
    extracted: { category: 'Food', budgetAmount: 800 },
    rawText: 'Set food budget to $800/month',
  });

  assert.match(reply, /Food/);
  assert.match(reply, /800\.00/);

  const { findBudgetByCategory } = await import('../budget/service');
  const budget = await findBudgetByCategory('Food');
  assert.ok(budget);
  assert.equal(budget!.amount_sgd, 80000);
});

test('buildAssistantReply removes a budget when the action indicates removal', async () => {
  const { setBudget, findBudgetByCategory } = await import('../budget/service');
  await setBudget('Travel', 200, 'SGD');

  const reply = await buildAssistantReply({
    intent: 'budget',
    confidence: 0.9,
    extracted: { category: 'Travel', action: 'remove' },
    rawText: 'Remove my travel budget',
  });

  assert.match(reply, /removed/i);
  assert.match(reply, /Travel/);

  const budget = await findBudgetByCategory('Travel');
  assert.equal(budget, null);
});

test('buildAssistantReply asks for a category when the budget intent has none', async () => {
  const reply = await buildAssistantReply({
    intent: 'budget',
    confidence: 0.5,
    extracted: {},
    rawText: 'set a budget',
  });

  assert.match(reply, /which category/i);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test src/bot/ai.test.ts`
Expected: FAIL on the three new tests — the current `'budget'` case returns a canned string that doesn't match `/800\.00/`, doesn't delete anything, and doesn't ask for a category.

- [ ] **Step 3: Rewrite the `'budget'` case**

In `src/bot/ai.ts`, replace the existing block:

```typescript
    case 'budget': {
      const amount = extracted.budgetAmount ?? extracted.amount ?? 0;
      const category = extracted.category ?? 'your category';
      return `Nice, that looks like a budget update for ${category}. I'll set the target to $${amount.toFixed(2)} and keep it synced with your monthly plan.`;
    }
```

with:

```typescript
    case 'budget': {
      const { setBudget, removeBudget } = await import('../budget/service');
      const { normalizeCategoryName } = await import('../expense/categorizer');

      if (!extracted.category) {
        return `Sure — which category's budget should I update? Try "Set food budget to $800/month".`;
      }

      const category = normalizeCategoryName(extracted.category);
      const isRemoval = /remove|delete|cancel/i.test(extracted.action ?? rawText);

      if (isRemoval) {
        await removeBudget(category);
        return `Done — removed the ${category} budget.`;
      }

      const amount = extracted.budgetAmount ?? extracted.amount ?? 0;
      if (amount <= 0) {
        return `What amount should the ${category} budget be? Try "Set food budget to $800/month".`;
      }

      const budget = await setBudget(category, amount);
      return `Got it — ${category} budget set to S$${(budget.amount_sgd / 100).toFixed(2)}/month.`;
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx --test src/bot/ai.test.ts`
Expected: PASS, including the pre-existing tests in this file.

- [ ] **Step 5: Run the full suite to check for regressions**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/bot/ai.ts src/bot/ai.test.ts
git commit -m "feat(bot): wire the budget chat intent to real setBudget/removeBudget"
```

---

### Task 8: Deliver alerts from the recurring scheduler

**Files:**
- Modify: `src/scheduler/recurring.ts`
- Create: `src/scheduler/recurring.test.ts`
- Modify: `package.json` (test script)

**Interfaces:**
- Consumes: `checkAlerts` from `../budget/alerts` (Task 4), `config` from `../config` (existing, `TELEGRAM_AUTHORIZED_CHAT_ID`), `Transaction` from `../types` (existing), grammy's `Api`/`Bot` types.
- Produces:
  - `deliverBudgetAlerts(api: Api | null, transactions: Transaction[]): Promise<void>` (new, exported for testing and for Task 9)
  - `startRecurringScheduler(bot: Bot | null): void` (signature changed — was `(): void`)
  - `triggerRecurringNow(bot: Bot | null): Promise<void>` (signature changed — was `(): Promise<void>`)

- [ ] **Step 1: Write the failing test**

Create `src/scheduler/recurring.test.ts`:

```typescript
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.DATABASE_URL = './data/test-scheduler-alerts.db';
process.env.TELEGRAM_AUTHORIZED_CHAT_ID = 'test-chat-id';

const testDbPath = path.resolve('./data/test-scheduler-alerts.db');
if (fs.existsSync(testDbPath)) {
  fs.rmSync(testDbPath, { force: true });
}

before(async () => {
  const { runMigrations } = await import('../db/migrate');
  runMigrations();
});

function fakeTransaction(category: string, amountSgdCents: number) {
  const now = new Date();
  return {
    id: randomUUID(),
    amount: amountSgdCents,
    currency: 'SGD' as const,
    amount_sgd: amountSgdCents,
    merchant: 'Test merchant',
    category: category as any,
    source: 'recurring',
    card_name: 'Recurring',
    created_at: now,
    updated_at: now,
  };
}

test('deliverBudgetAlerts does nothing when there are no transactions', async () => {
  const { deliverBudgetAlerts } = await import('./recurring');
  const sent: Array<{ chatId: string; text: string }> = [];
  const fakeApi = { sendMessage: async (chatId: string, text: string) => { sent.push({ chatId, text }); } } as any;

  await deliverBudgetAlerts(fakeApi, []);
  assert.equal(sent.length, 0);
});

test('deliverBudgetAlerts does nothing when no api is available', async () => {
  const { deliverBudgetAlerts } = await import('./recurring');
  await deliverBudgetAlerts(null, [fakeTransaction('Food', 8500)]);
  // No assertion beyond "resolves without throwing" — there's no budget
  // seeded for Food here, and no api to call even if there were.
});

test('deliverBudgetAlerts sends a message when a transaction crosses a threshold', async () => {
  const { setBudget } = await import('../budget/service');
  const { deliverBudgetAlerts } = await import('./recurring');

  await setBudget('Entertainment', 100, 'SGD');

  const sent: Array<{ chatId: string; text: string }> = [];
  const fakeApi = { sendMessage: async (chatId: string, text: string) => { sent.push({ chatId, text }); } } as any;

  await deliverBudgetAlerts(fakeApi, [fakeTransaction('Entertainment', 8500)]);

  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, 'test-chat-id');
  assert.match(sent[0].text, /Entertainment/);
});
```

- [ ] **Step 2: Register the test file and run it to see it fail**

In `package.json`, update the `test` script to:

```json
"test": "npx tsx --test src/bot/ai.test.ts src/expense/expense.test.ts src/budget/service.test.ts src/budget/progress.test.ts src/budget/alerts.test.ts src/scheduler/recurring.test.ts",
```

Run: `npx tsx --test src/scheduler/recurring.test.ts`
Expected: FAIL — `deliverBudgetAlerts` is not exported from `./recurring` yet.

- [ ] **Step 3: Rewrite `recurring.ts`**

Replace the full contents of `src/scheduler/recurring.ts` with:

```typescript
/**
 * Recurring transactions scheduler
 * Automatically logs recurring transactions on their scheduled day,
 * then checks each one against budget alert thresholds.
 */

import * as cron from 'node-cron';
import { Api, Bot } from 'grammy';
import { fireRecurringForToday } from '../expense/service';
import { checkAlerts } from '../budget/alerts';
import { Transaction } from '../types';
import { config } from '../config';
import { logger } from '../utils/logger';

let schedulerTask: cron.ScheduledTask | null = null;

/**
 * Check each newly created transaction against its category budget and
 * push a Telegram message for any newly crossed threshold.
 */
export async function deliverBudgetAlerts(api: Api | null, transactions: Transaction[]): Promise<void> {
  if (transactions.length === 0) {
    return;
  }

  if (!api) {
    logger.warn('Skipping budget alert delivery: no bot instance available');
    return;
  }

  if (!config.TELEGRAM_AUTHORIZED_CHAT_ID) {
    logger.warn('Skipping budget alert delivery: TELEGRAM_AUTHORIZED_CHAT_ID is not configured');
    return;
  }

  for (const transaction of transactions) {
    const alert = await checkAlerts(transaction);
    if (alert) {
      await api.sendMessage(config.TELEGRAM_AUTHORIZED_CHAT_ID, alert.message);
    }
  }
}

/**
 * Start the recurring transactions scheduler.
 * Runs daily at midnight (00:00) to check and log any recurring transactions due today.
 * `bot` is used to push budget alerts for any transaction it creates — pass null
 * if the Telegram bot isn't running (alerts are then skipped, with a log warning).
 */
export function startRecurringScheduler(bot: Bot | null): void {
  if (schedulerTask) {
    logger.warn('Recurring scheduler already running, skipping start');
    return;
  }

  schedulerTask = cron.schedule('0 0 * * *', async () => {
    logger.info('Running recurring transactions scheduler');
    try {
      const created = await fireRecurringForToday();
      if (created.length > 0) {
        logger.info(`Created ${created.length} recurring transaction(s)`, {
          transactions: created.map((t) => ({
            merchant: t.merchant,
            amount: t.amount,
            category: t.category,
          })),
        });
        await deliverBudgetAlerts(bot?.api ?? null, created);
      } else {
        logger.debug('No recurring transactions due today');
      }
    } catch (error) {
      logger.error('Failed to process recurring transactions', error);
    }
  });

  logger.info('Recurring transactions scheduler started (runs daily at 00:00)');
}

/**
 * Stop the recurring transactions scheduler
 */
export function stopRecurringScheduler(): void {
  if (schedulerTask) {
    schedulerTask.stop();
    schedulerTask = null;
    logger.info('Recurring transactions scheduler stopped');
  }
}

/**
 * Manually trigger recurring transactions (useful for testing or startup recovery)
 */
export async function triggerRecurringNow(bot: Bot | null): Promise<void> {
  logger.info('Manually triggering recurring transactions');
  try {
    const created = await fireRecurringForToday();
    logger.info(`Manually created ${created.length} recurring transaction(s)`);
    await deliverBudgetAlerts(bot?.api ?? null, created);
  } catch (error) {
    logger.error('Failed to manually trigger recurring transactions', error);
    throw error;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test src/scheduler/recurring.test.ts`
Expected: PASS, all 3 tests green.

- [ ] **Step 5: Run the full suite to check for regressions**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/scheduler/recurring.ts src/scheduler/recurring.test.ts package.json
git commit -m "feat(scheduler): deliver budget alerts after firing recurring transactions"
```

---

### Task 9: Pass the bot instance into the scheduler from `src/index.ts`

**Files:**
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `startRecurringScheduler(bot: Bot | null)`, `triggerRecurringNow(bot: Bot | null)` from `./scheduler/recurring` (Task 8, signatures changed), `PlutoBot.getBot(): Bot` from `./bot` (existing, `src/bot/index.ts:112-114`, unchanged).

- [ ] **Step 1: Update `initialize()`**

In `src/index.ts`, the current block:

```typescript
    if (config.TELEGRAM_BOT_TOKEN) {
      const bot = new PlutoBot();
      await bot.start();
      logger.info('Telegram bot core initialized');
    } else {
      logger.warn('Telegram bot not started because TELEGRAM_BOT_TOKEN is not configured');
    }

    // Start recurring transactions scheduler
    startRecurringScheduler();

    // Check and fire any recurring transactions that may have been missed during downtime
    logger.info('Checking for recurring transactions due today...');
    await triggerRecurringNow();
```

becomes:

```typescript
    let plutoBot: PlutoBot | null = null;
    if (config.TELEGRAM_BOT_TOKEN) {
      plutoBot = new PlutoBot();
      await plutoBot.start();
      logger.info('Telegram bot core initialized');
    } else {
      logger.warn('Telegram bot not started because TELEGRAM_BOT_TOKEN is not configured');
    }

    // Start recurring transactions scheduler
    startRecurringScheduler(plutoBot ? plutoBot.getBot() : null);

    // Check and fire any recurring transactions that may have been missed during downtime
    logger.info('Checking for recurring transactions due today...');
    await triggerRecurringNow(plutoBot ? plutoBot.getBot() : null);
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: pass the bot instance into the recurring scheduler for alert delivery"
```

---

### Task 10: Final verification and doc sync

**Files:**
- Modify: `doc/tasks/05-budget-system.md`

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: PASS — all files listed in `package.json`'s `test` script succeed.

- [ ] **Step 2: Run the type checker and build**

Run: `npx tsc --noEmit && npm run build`
Expected: no type errors, `dist/` builds successfully.

- [ ] **Step 3: Update the task doc's status**

In `doc/tasks/05-budget-system.md`, change:

```markdown
**Status: not started.** No `src/budget/` directory exists; `/budget`
(src/bot/commands/budget.ts) is a hardcoded placeholder string. The
`budgets` table exists in the schema but nothing reads or writes to it.
None of the criteria below are implemented.
```

to:

```markdown
**Status: implemented.** See `src/budget/`, the wired `/budget`
command, the `budget` chat intent, and the recurring scheduler's alert
delivery.
```

And check off every item in the "Acceptance Criteria" list (`- [ ]` → `- [x]`) for the eight bullets under that heading.

- [ ] **Step 4: Commit**

```bash
git add doc/tasks/05-budget-system.md
git commit -m "docs: mark PLUTO-05 budget system as implemented"
```
