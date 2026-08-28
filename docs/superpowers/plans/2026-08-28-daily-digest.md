# PLUTO-06 Daily Digest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a `src/digest/` module that assembles today's spending, budget health, and recurring-transaction activity into one Telegram message, sent nightly at 10 PM SGT via node-cron and previewable on demand via `/digest`.

**Architecture:** A pure aggregator (`collectDigestData`) pulls from the existing expense and budget modules, isolating each source's failure into a `{ error }` result instead of throwing. A pure formatter turns that data plus an AI-generated (Gemini, with rule-based fallback) one-liner into the final message string. A thin scheduler/sender (`index.ts`) wires node-cron and Telegram delivery around those two pure pieces, mirroring the existing `src/scheduler/recurring.ts` pattern.

**Tech Stack:** TypeScript, node-cron (already a dependency), `@google/generative-ai` (existing Gemini client pattern from `src/bot/ai.ts`), grammy `Bot`/`Api`, node's built-in test runner (`node:test`).

**Spec:** [docs/superpowers/specs/2026-08-28-daily-digest-design.md](../specs/2026-08-28-daily-digest-design.md)

## Global Constraints

- All monetary amounts are integer cents; display them with the existing inline convention `S$${(cents / 100).toFixed(2)}` (see `handleTodayCommand`/`handleBudgetCommand`) — no new shared money formatter.
- The digest must still produce and attempt to send a message even if any one data source fails — no function in the aggregator/formatter path may throw for a single-source failure.
- Timezone is hardcoded via node-cron's `{ timezone: 'Asia/Singapore' }` option (confirmed present in `node_modules/node-cron/dist/*.d.ts`) — `0 22 * * *`.
- The digest must never call `fireRecurringForToday()` — it only reads already-persisted `source = 'recurring'` transactions, since the midnight scheduler already fires them once and calling it again would double-log.
- The portfolio section is a permanent `{ error: 'not yet implemented' }` stub — no portfolio service is built in this plan (PLUTO-04 is out of scope).
- Any code that calls Gemini must be exercised in tests with `global.fetch` stubbed to fail, so the test suite stays network-free by default (matching `src/bot/ai.test.ts`'s documented convention in `CLAUDE.md`).
- New test files must be added to the `test` script in `package.json` or they will not run.

---

### Task 1: Add per-category transaction counts to `SpendingSummary`

**Files:**
- Modify: `src/expense/types.ts:28-34` (the `SpendingSummary` interface)
- Modify: `src/expense/service.ts:129-155` (`getSpendingSummary`)
- Test: `src/expense/expense.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `SpendingSummary.byCategoryCount: Record<string, number>` — later tasks' formatter reads this field.

- [ ] **Step 1: Write the failing test**

Add to the end of `src/expense/expense.test.ts`:

```typescript
test('getSpendingSummary tracks a per-category transaction count', async () => {
  const { logExpense, getSpendingSummary } = await import('./index');
  const before = await getSpendingSummary('today');
  const beforeCount = before.byCategoryCount.Entertainment ?? 0;

  await logExpense({ amount: 10, currency: 'SGD', merchant: 'Netflix subscription', source: 'text' });
  await logExpense({ amount: 10, currency: 'SGD', merchant: 'Netflix subscription', source: 'text' });

  const after = await getSpendingSummary('today');
  assert.equal(after.byCategoryCount.Entertainment, beforeCount + 2);

  const totalFromCounts = Object.values(after.byCategoryCount).reduce((sum, n) => sum + n, 0);
  assert.equal(totalFromCounts, after.count);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/expense/expense.test.ts`
Expected: FAIL — `after.byCategoryCount` is `undefined` (`TypeError: Cannot read properties of undefined`).

- [ ] **Step 3: Write minimal implementation**

In `src/expense/types.ts`, add the field to `SpendingSummary`:

```typescript
export interface SpendingSummary {
  period: SpendingPeriod;
  total: number;
  count: number;
  byCategory: Record<string, number>;
  byCategoryCount: Record<string, number>;
  topExpenses: Transaction[];
}
```

In `src/expense/service.ts`, update `getSpendingSummary`:

```typescript
export async function getSpendingSummary(period: SpendingPeriod): Promise<SpendingSummary> {
  const db = getSQLiteDb();
  const start = startOfPeriod(period);
  const rows = db
    .prepare('SELECT * FROM transactions WHERE created_at >= ? ORDER BY created_at DESC')
    .all(start) as any[];

  const byCategory: Record<string, number> = {};
  const byCategoryCount: Record<string, number> = {};
  let total = 0;

  for (const row of rows) {
    total += Number(row.amount_sgd);
    const category = String(row.category);
    byCategory[category] = (byCategory[category] ?? 0) + Number(row.amount_sgd);
    byCategoryCount[category] = (byCategoryCount[category] ?? 0) + 1;
  }

  const summary: SpendingSummary = {
    period,
    total,
    count: rows.length,
    byCategory,
    byCategoryCount,
    topExpenses: rows.slice(0, 5).map((row) => mapTransactionRow(row)),
  };

  db.close();
  return summary;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/expense/expense.test.ts`
Expected: PASS (all tests in the file, including the pre-existing ones).

- [ ] **Step 5: Commit**

```bash
git add src/expense/types.ts src/expense/service.ts src/expense/expense.test.ts
git commit -m "feat: track per-category transaction counts in SpendingSummary"
```

---

### Task 2: Add a read-only `getRecurringFiredToday`

**Files:**
- Modify: `src/expense/service.ts` (add function after `fireRecurringForToday`, currently ending at line 274)
- Modify: `src/expense/index.ts:8-22` (export list)
- Test: `src/expense/expense.test.ts`

**Interfaces:**
- Consumes: `startOfPeriod('today')`, `getSQLiteDb()`, `mapTransactionRow()` — all already defined in `src/expense/service.ts`.
- Produces: `getRecurringFiredToday(): Promise<Transaction[]>`, exported from `src/expense` — the digest aggregator (Task 3) imports this.

- [ ] **Step 1: Write the failing test**

Add to the end of `src/expense/expense.test.ts`:

```typescript
test('getRecurringFiredToday reports already-fired recurring transactions without inserting new ones', async () => {
  const { createRecurring, fireRecurringForToday, getRecurringFiredToday } = await import('./index');
  const recurring = await createRecurring({
    amount: 500,
    currency: 'SGD',
    merchant: 'Spotify',
    category: 'Entertainment',
    day_of_month: new Date().getDate(),
    is_active: true,
  });

  await fireRecurringForToday();

  const first = await getRecurringFiredToday();
  const second = await getRecurringFiredToday();

  assert.equal(first.length, second.length);
  assert.ok(first.some((t) => t.merchant === recurring.merchant));
  assert.ok(first.every((t) => t.source === 'recurring'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/expense/expense.test.ts`
Expected: FAIL — `getRecurringFiredToday is not a function` (not exported from `./index` yet).

- [ ] **Step 3: Write minimal implementation**

In `src/expense/service.ts`, add after `fireRecurringForToday` (before `correctLastTransaction`):

```typescript
export async function getRecurringFiredToday(): Promise<Transaction[]> {
  const db = getSQLiteDb();
  const start = startOfPeriod('today');
  const rows = db
    .prepare("SELECT * FROM transactions WHERE source = 'recurring' AND created_at >= ? ORDER BY created_at DESC")
    .all(start) as any[];
  db.close();
  return rows.map((row) => mapTransactionRow(row));
}
```

In `src/expense/index.ts`, add `getRecurringFiredToday` to the export list (alphabetically, before `getSpendingByCategory`):

```typescript
export {
  compareSpending,
  correctLastTransaction,
  createRecurring,
  exportCSV,
  fireRecurringForToday,
  getRecurringFiredToday,
  getSpendingByCategory,
  getSpendingSummary,
  getTopExpenses,
  listRecurring,
  logExpense,
  pauseRecurring,
  removeRecurring,
  undoLastTransaction,
} from './service';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/expense/expense.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Commit**

```bash
git add src/expense/service.ts src/expense/index.ts src/expense/expense.test.ts
git commit -m "feat: add read-only getRecurringFiredToday for the daily digest"
```

---

### Task 3: Digest types and aggregator

**Files:**
- Create: `src/digest/types.ts`
- Create: `src/digest/aggregator.ts`
- Test: `src/digest/digest.test.ts`

**Interfaces:**
- Consumes: `getSpendingSummary('today')`, `getRecurringFiredToday()` from `src/expense` (Tasks 1-2); `getBudgetStatus()` from `src/budget` (existing).
- Produces: `SectionResult<T>`, `DigestData` types; `collectDigestData(): Promise<DigestData>`; `settle<T>(section: string, promise: Promise<T>): Promise<SectionResult<T>>` — Tasks 4-6 import `DigestData`/`SectionResult` from `./types`, and Task 6 imports `collectDigestData` from `./aggregator`.

- [ ] **Step 1: Write the failing test**

Create `src/digest/digest.test.ts`:

```typescript
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

process.env.DATABASE_URL = './data/test-digest.db';
process.env.TELEGRAM_AUTHORIZED_CHAT_ID = 'test-chat-id';

const testDbPath = path.resolve('./data/test-digest.db');
if (fs.existsSync(testDbPath)) {
  fs.rmSync(testDbPath, { force: true });
}

const originalFetch = global.fetch;

before(async () => {
  const { runMigrations } = await import('../db/migrate');
  runMigrations();

  // No test in this file needs a real Gemini call — stub fetch so
  // generateSummaryLine (Task 5) deterministically falls back to its
  // rule-based line, keeping the suite network-free by default.
  global.fetch = (() => {
    throw new Error('simulated network failure');
  }) as typeof fetch;
});

after(() => {
  global.fetch = originalFetch;
});

test('settle degrades a rejected promise into a SectionResult error without throwing', async () => {
  const { settle } = await import('./aggregator');
  const result = await settle('testSection', Promise.reject(new Error('boom')));
  assert.deepEqual(result, { error: 'boom' });
});

test('settle passes a resolved value through unchanged', async () => {
  const { settle } = await import('./aggregator');
  const result = await settle('testSection', Promise.resolve({ ok: true }));
  assert.deepEqual(result, { ok: true });
});

test('collectDigestData returns real data for all live sources and a permanent portfolio stub', async () => {
  const { collectDigestData } = await import('./aggregator');
  const data = await collectDigestData();

  assert.ok('total' in (data.spending as object));
  assert.ok(Array.isArray(data.recurringFired));
  assert.ok(Array.isArray(data.budgetStatuses));
  assert.deepEqual(data.portfolio, { error: 'not yet implemented' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/digest/digest.test.ts`
Expected: FAIL — `Cannot find module './aggregator'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/digest/types.ts`:

```typescript
/**
 * Digest module types
 */

import { BudgetStatus } from '../budget';
import { SpendingSummary } from '../expense';
import { Transaction } from '../types';

export type SectionResult<T> = T | { error: string };

export interface DigestData {
  spending: SectionResult<SpendingSummary>;
  recurringFired: SectionResult<Transaction[]>;
  budgetStatuses: SectionResult<BudgetStatus[]>;
  portfolio: { error: string };
}
```

Create `src/digest/aggregator.ts`:

```typescript
/**
 * Collects digest data from the expense and budget modules. Each source is
 * isolated — one failing source degrades to a SectionResult error and never
 * blocks or fails the others.
 */

import { getSpendingSummary, getRecurringFiredToday } from '../expense';
import { getBudgetStatus } from '../budget';
import { logger } from '../utils/logger';
import { DigestData, SectionResult } from './types';

export async function settle<T>(section: string, promise: Promise<T>): Promise<SectionResult<T>> {
  try {
    return await promise;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`Digest section "${section}" failed, degrading gracefully`, { error: message });
    return { error: message };
  }
}

export async function collectDigestData(): Promise<DigestData> {
  const [spending, recurringFired, budgetStatuses] = await Promise.all([
    settle('spending', getSpendingSummary('today')),
    settle('recurringFired', getRecurringFiredToday()),
    settle('budgetStatuses', getBudgetStatus()),
  ]);

  return {
    spending,
    recurringFired,
    budgetStatuses,
    portfolio: { error: 'not yet implemented' },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/digest/digest.test.ts`
Expected: PASS (all three tests).

- [ ] **Step 5: Commit**

```bash
git add src/digest/types.ts src/digest/aggregator.ts src/digest/digest.test.ts
git commit -m "feat: add digest data aggregator with per-source graceful degradation"
```

---

### Task 4: Digest formatter

**Files:**
- Create: `src/digest/formatter.ts`
- Test: `src/digest/digest.test.ts` (append)

**Interfaces:**
- Consumes: `DigestData`, `SectionResult<T>` from `./types` (Task 3).
- Produces: `formatDigestMessage(data: DigestData, summaryLine: string): string` — Task 6's `buildDigestMessage` calls this.

- [ ] **Step 1: Write the failing test**

Append to `src/digest/digest.test.ts`:

```typescript
function emptySpending() {
  return { period: 'today' as const, total: 0, count: 0, byCategory: {}, byCategoryCount: {}, topExpenses: [] };
}

test('formatDigestMessage renders "no spending today" when total is zero', async () => {
  const { formatDigestMessage } = await import('./formatter');

  const data = {
    spending: emptySpending(),
    recurringFired: [],
    budgetStatuses: [],
    portfolio: { error: 'not yet implemented' },
  };

  const message = formatDigestMessage(data as any, 'All good.');
  assert.match(message, /no spending today/i);
});

test('formatDigestMessage omits Budget/Auto-logged when empty and renders them when present', async () => {
  const { formatDigestMessage } = await import('./formatter');

  const baseData = {
    spending: { period: 'today' as const, total: 1000, count: 1, byCategory: { Food: 1000 }, byCategoryCount: { Food: 1 }, topExpenses: [] },
    recurringFired: [],
    budgetStatuses: [],
    portfolio: { error: 'not yet implemented' },
  };

  const emptyMessage = formatDigestMessage(baseData as any, 'All good.');
  assert.doesNotMatch(emptyMessage, /Auto-logged/);
  assert.doesNotMatch(emptyMessage, /Budget:/);

  const filledData = {
    ...baseData,
    recurringFired: [
      {
        id: '1',
        amount: 1500,
        currency: 'SGD',
        amount_sgd: 1500,
        merchant: 'Netflix',
        category: 'Entertainment',
        source: 'recurring',
        card_name: 'Recurring',
        created_at: new Date(),
        updated_at: new Date(),
      },
    ],
    budgetStatuses: [
      {
        category: 'Food',
        budget_amount: 10000,
        budget_currency: 'SGD',
        budget_sgd: 10000,
        spent_sgd: 6250,
        percentage: 62.5,
        remaining_sgd: 3750,
        days_left_in_month: 3,
      },
    ],
  };

  const filledMessage = formatDigestMessage(filledData as any, 'All good.');
  assert.match(filledMessage, /Auto-logged: S\$15\.00 Netflix \(recurring\)/);
  assert.match(filledMessage, /Budget: Food 62\.5% used \(3 days left\)/);
});

test('formatDigestMessage renders the portfolio stub as unavailable', async () => {
  const { formatDigestMessage } = await import('./formatter');

  const data = {
    spending: emptySpending(),
    recurringFired: [],
    budgetStatuses: [],
    portfolio: { error: 'not yet implemented' },
  };

  const message = formatDigestMessage(data as any, 'All good.');
  assert.match(message, /Portfolio: unavailable \(not yet implemented\)/);
});

test('formatDigestMessage renders a failed section as unavailable with its reason', async () => {
  const { formatDigestMessage } = await import('./formatter');

  const data = {
    spending: { error: 'db locked' },
    recurringFired: [],
    budgetStatuses: [],
    portfolio: { error: 'not yet implemented' },
  };

  const message = formatDigestMessage(data as any, 'All good.');
  assert.match(message, /Spending: unavailable \(db locked\)/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/digest/digest.test.ts`
Expected: FAIL — `Cannot find module './formatter'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/digest/formatter.ts`:

```typescript
/**
 * Builds the digest message string from collected data. Pure — no I/O.
 */

import { DigestData, SectionResult } from './types';

function isError<T>(section: SectionResult<T>): section is { error: string } {
  return typeof section === 'object' && section !== null && 'error' in section;
}

function money(cents: number): string {
  return `S$${(cents / 100).toFixed(2)}`;
}

function formatDate(date: Date): string {
  return date.toLocaleDateString('en-SG', { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatSpendingSection(section: DigestData['spending']): string {
  if (isError(section)) {
    return `Spending: unavailable (${section.error})`;
  }

  if (section.total === 0) {
    return `Spent today: ${money(0)} — no spending today.`;
  }

  const lines = [`Spent today: ${money(section.total)}`];
  for (const [category, amount] of Object.entries(section.byCategory)) {
    const count = section.byCategoryCount[category] ?? 0;
    const label = count === 1 ? 'txn' : 'txns';
    lines.push(`  ${category}: ${money(amount)} (${count} ${label})`);
  }
  return lines.join('\n');
}

function formatRecurringSection(section: DigestData['recurringFired']): string | null {
  if (isError(section)) {
    return `Auto-logged: unavailable (${section.error})`;
  }

  if (section.length === 0) {
    return null;
  }

  return section
    .map((txn) => `Auto-logged: ${money(txn.amount_sgd)} ${txn.merchant} (recurring)`)
    .join('\n');
}

function formatBudgetSection(section: DigestData['budgetStatuses']): string | null {
  if (isError(section)) {
    return `Budget: unavailable (${section.error})`;
  }

  if (section.length === 0) {
    return null;
  }

  return section
    .map((status) => `Budget: ${status.category} ${status.percentage}% used (${status.days_left_in_month} days left)`)
    .join('\n');
}

function formatPortfolioSection(section: DigestData['portfolio']): string {
  return `Portfolio: unavailable (${section.error})`;
}

export function formatDigestMessage(data: DigestData, summaryLine: string): string {
  const sections = [`Daily Digest - ${formatDate(new Date())}`, '', formatSpendingSection(data.spending)];

  const recurring = formatRecurringSection(data.recurringFired);
  if (recurring) {
    sections.push('', recurring);
  }

  const budget = formatBudgetSection(data.budgetStatuses);
  if (budget) {
    sections.push('', budget);
  }

  sections.push('', formatPortfolioSection(data.portfolio));
  sections.push('', summaryLine);

  return sections.join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/digest/digest.test.ts`
Expected: PASS (all tests, including Task 3's).

- [ ] **Step 5: Commit**

```bash
git add src/digest/formatter.ts src/digest/digest.test.ts
git commit -m "feat: add digest message formatter with per-section graceful degradation"
```

---

### Task 5: AI summary line with rule-based fallback

**Files:**
- Create: `src/digest/summary.ts`
- Test: `src/digest/digest.test.ts` (append)

**Interfaces:**
- Consumes: `DigestData`, `SectionResult<T>` from `./types` (Task 3); `config.GOOGLE_API_KEY` from `src/config`; `logger` from `src/utils/logger`.
- Produces: `generateSummaryLine(data: DigestData): Promise<string>` — Task 6's `buildDigestMessage` calls this.

- [ ] **Step 1: Write the failing test**

Append to `src/digest/digest.test.ts` (the file's module-level `before()` already stubs `global.fetch` to fail, so both cases below exercise the rule-based fallback deterministically):

```typescript
test('generateSummaryLine falls back to "Watch {category} spending." when a budget is at or above 80%', async () => {
  const { generateSummaryLine } = await import('./summary');

  const data = {
    spending: emptySpending(),
    recurringFired: [],
    budgetStatuses: [
      {
        category: 'Food',
        budget_amount: 10000,
        budget_currency: 'SGD',
        budget_sgd: 10000,
        spent_sgd: 9000,
        percentage: 90,
        remaining_sgd: 1000,
        days_left_in_month: 2,
      },
    ],
    portfolio: { error: 'not yet implemented' },
  };

  const line = await generateSummaryLine(data as any);
  assert.equal(line, 'Watch Food spending.');
});

test('generateSummaryLine falls back to "All good." when no budget is over threshold', async () => {
  const { generateSummaryLine } = await import('./summary');

  const data = {
    spending: emptySpending(),
    recurringFired: [],
    budgetStatuses: [],
    portfolio: { error: 'not yet implemented' },
  };

  const line = await generateSummaryLine(data as any);
  assert.equal(line, 'All good.');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/digest/digest.test.ts`
Expected: FAIL — `Cannot find module './summary'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/digest/summary.ts`:

```typescript
/**
 * Generates the digest's closing one-liner via Gemini, falling back to a
 * rule-based line if the call fails, times out, or returns nothing.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from '../config';
import { logger } from '../utils/logger';
import { DigestData, SectionResult } from './types';

function isError<T>(section: SectionResult<T>): section is { error: string } {
  return typeof section === 'object' && section !== null && 'error' in section;
}

function ruleBasedSummary(data: DigestData): string {
  if (!isError(data.budgetStatuses)) {
    const overThreshold = data.budgetStatuses.find((status) => status.percentage >= 80);
    if (overThreshold) {
      return `Watch ${overThreshold.category} spending.`;
    }
  }
  return 'All good.';
}

function buildPrompt(data: DigestData): string {
  const totalCents = isError(data.spending) ? 0 : data.spending.total;
  const topCategory = isError(data.spending)
    ? null
    : Object.entries(data.spending.byCategory).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  return `Today's spending: S$${(totalCents / 100).toFixed(2)}${
    topCategory ? `, mostly on ${topCategory}` : ''
  }. Write one short, friendly one-line comment (under 15 words, no emoji) for a personal finance digest message.`;
}

export async function generateSummaryLine(data: DigestData): Promise<string> {
  try {
    const genAI = new GoogleGenerativeAI(config.GOOGLE_API_KEY);
    const model = genAI.getGenerativeModel({
      model: 'gemini-3.6-flash',
      systemInstruction:
        'You are Pluto AI, a personal finance assistant. Reply with exactly one short plain-text sentence, no markdown, no quotes.',
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Gemini summary call timed out after 5s')), 5000);
    });

    const result = await Promise.race([model.generateContent(buildPrompt(data)), timeoutPromise]);
    const text = result.response.text().trim();

    if (!text) {
      logger.warn('Gemini returned an empty digest summary, falling back to rule-based line');
      return ruleBasedSummary(data);
    }

    return text;
  } catch (error) {
    logger.error('Gemini digest summary failed, falling back to rule-based line', error);
    return ruleBasedSummary(data);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/digest/digest.test.ts`
Expected: PASS (all tests, including Tasks 3-4's).

- [ ] **Step 5: Commit**

```bash
git add src/digest/summary.ts src/digest/digest.test.ts
git commit -m "feat: add AI digest summary line with rule-based fallback"
```

---

### Task 6: Scheduler, trigger, and message builder

**Files:**
- Create: `src/digest/index.ts`
- Test: `src/digest/digest.test.ts` (append)

**Interfaces:**
- Consumes: `collectDigestData` from `./aggregator` (Task 3); `formatDigestMessage` from `./formatter` (Task 4); `generateSummaryLine` from `./summary` (Task 5); `config`, `logger`.
- Produces: `buildDigestMessage(): Promise<string>`, `triggerDigestNow(bot: Bot | null): Promise<void>`, `startDigestScheduler(bot: Bot | null): void`, `stopDigestScheduler(): void` — Task 7 (`/digest` command) calls `buildDigestMessage`; Task 8 (`src/index.ts` wiring) calls `startDigestScheduler`.

- [ ] **Step 1: Write the failing test**

Append to `src/digest/digest.test.ts`:

```typescript
test('triggerDigestNow does not throw when no bot is available', async () => {
  const { triggerDigestNow } = await import('./index');
  await assert.doesNotReject(() => triggerDigestNow(null));
});

test('triggerDigestNow sends the built digest message through the bot api', async () => {
  const { triggerDigestNow } = await import('./index');
  const sent: Array<{ chatId: string; text: string }> = [];
  const fakeBot = {
    api: {
      sendMessage: async (chatId: string, text: string) => {
        sent.push({ chatId, text });
      },
    },
  } as any;

  await triggerDigestNow(fakeBot);

  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, 'test-chat-id');
  assert.match(sent[0].text, /Daily Digest/);
});

test('buildDigestMessage returns a string containing the digest header', async () => {
  const { buildDigestMessage } = await import('./index');
  const message = await buildDigestMessage();
  assert.match(message, /^Daily Digest - /);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/digest/digest.test.ts`
Expected: FAIL — `Cannot find module './index'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/digest/index.ts`:

```typescript
/**
 * Daily digest scheduler, manual trigger, and message builder.
 */

import * as cron from 'node-cron';
import { Bot } from 'grammy';
import { config } from '../config';
import { logger } from '../utils/logger';
import { collectDigestData } from './aggregator';
import { formatDigestMessage } from './formatter';
import { generateSummaryLine } from './summary';

let schedulerTask: cron.ScheduledTask | null = null;

export async function buildDigestMessage(): Promise<string> {
  const data = await collectDigestData();
  const summaryLine = await generateSummaryLine(data);
  return formatDigestMessage(data, summaryLine);
}

export async function triggerDigestNow(bot: Bot | null): Promise<void> {
  logger.info('Building daily digest');
  const message = await buildDigestMessage();

  if (!bot) {
    logger.warn('Skipping digest delivery: no bot instance available');
    return;
  }

  if (!config.TELEGRAM_AUTHORIZED_CHAT_ID) {
    logger.warn('Skipping digest delivery: TELEGRAM_AUTHORIZED_CHAT_ID is not configured');
    return;
  }

  try {
    await bot.api.sendMessage(config.TELEGRAM_AUTHORIZED_CHAT_ID, message);
    logger.info('Daily digest sent');
  } catch (error) {
    logger.error('Failed to send daily digest', error);
  }
}

export function startDigestScheduler(bot: Bot | null): void {
  if (schedulerTask) {
    logger.warn('Digest scheduler already running, skipping start');
    return;
  }

  schedulerTask = cron.schedule(
    '0 22 * * *',
    async () => {
      logger.info('Running daily digest scheduler');
      try {
        await triggerDigestNow(bot);
      } catch (error) {
        logger.error('Failed to run daily digest', error);
      }
    },
    { timezone: 'Asia/Singapore' },
  );

  logger.info('Daily digest scheduler started (runs daily at 22:00 Asia/Singapore)');
}

export function stopDigestScheduler(): void {
  if (schedulerTask) {
    schedulerTask.stop();
    schedulerTask = null;
    logger.info('Daily digest scheduler stopped');
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/digest/digest.test.ts`
Expected: PASS (all tests in the file, Tasks 3-6 combined).

- [ ] **Step 5: Commit**

```bash
git add src/digest/index.ts src/digest/digest.test.ts
git commit -m "feat: add digest scheduler, manual trigger, and message builder"
```

---

### Task 7: `/digest` bot command

**Files:**
- Create: `src/bot/commands/digest.ts`
- Modify: `src/bot/commands/index.ts:5-11`
- Modify: `src/bot/index.ts` (imports at top, command registration in `start()`)
- Modify: `src/bot/formatter/messages.ts:13-25` (`formatHelpMessage`)

**Interfaces:**
- Consumes: `buildDigestMessage` from `../../digest` (Task 6).
- Produces: `handleDigestCommand(): Promise<string>`, exported from `src/bot/commands`.

This task wires an existing, already-tested function (`buildDigestMessage`) into the bot — consistent with how `handlePortfolioCommand`/`handleTodayCommand`/etc. have no dedicated test files of their own, this task is verified manually rather than with a new automated test.

- [ ] **Step 1: Create the command handler**

Create `src/bot/commands/digest.ts`:

```typescript
/**
 * /digest command handler — manually preview tonight's digest.
 */

import { buildDigestMessage } from '../../digest';

export async function handleDigestCommand(): Promise<string> {
  return buildDigestMessage();
}
```

- [ ] **Step 2: Export it from the commands barrel**

In `src/bot/commands/index.ts`, add:

```typescript
export * from './digest';
```

(after `export * from './portfolio';`, keeping the existing order of the rest).

- [ ] **Step 3: Register the command in the bot**

In `src/bot/index.ts`, add the import alongside the other command imports:

```typescript
import { handleDigestCommand } from './commands/digest';
```

and register it in `start()`, alongside the other `this.bot.command(...)` calls (after the `'undo'` block, before `'help'`):

```typescript
this.bot.command('digest', async (ctx) => {
  const response = await handleDigestCommand();
  await this.replyWithText(ctx, response);
});
```

- [ ] **Step 4: Add it to the help message**

In `src/bot/formatter/messages.ts`, update `formatHelpMessage`:

```typescript
export function formatHelpMessage(): string {
  return formatLines('Plutus commands', [
    '/portfolio - quick portfolio check',
    '/today - today\'s spend',
    '/month - monthly breakdown',
    '/budget - budget status',
    '/export - export your data',
    '/undo - undo the last transaction',
    '/digest - preview tonight\'s digest',
    '/help - this menu',
    '',
    'Or just message me naturally, like “Spent $4.50 at Ya Kun”.',
  ]);
}
```

- [ ] **Step 5: Manually verify**

Run: `npm run dev` (requires `TELEGRAM_BOT_TOKEN` configured), send `/digest` to the bot, and confirm a digest message is returned with today's data.

- [ ] **Step 6: Commit**

```bash
git add src/bot/commands/digest.ts src/bot/commands/index.ts src/bot/index.ts src/bot/formatter/messages.ts
git commit -m "feat: add /digest command to preview the daily digest on demand"
```

---

### Task 8: Start the digest scheduler on boot

**Files:**
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `startDigestScheduler` from `./digest` (Task 6).
- Produces: nothing new — this is the application's entry-point wiring.

Like the existing `startRecurringScheduler` call, this is boot-time wiring with no dedicated unit test (`src/index.ts` has none today). Verified manually.

- [ ] **Step 1: Add the import and start call**

In `src/index.ts`, add the import alongside the existing scheduler import:

```typescript
import { startRecurringScheduler, triggerRecurringNow } from './scheduler/recurring';
import { startDigestScheduler } from './digest';
```

and add the start call right after `startRecurringScheduler(...)`:

```typescript
    // Start recurring transactions scheduler
    startRecurringScheduler(plutoBot ? plutoBot.getBot() : null);

    // Start daily digest scheduler (10 PM Asia/Singapore) — no catch-up on
    // startup by design; a missed 10pm run is skipped, not backfilled.
    startDigestScheduler(plutoBot ? plutoBot.getBot() : null);

    // Check and fire any recurring transactions that may have been missed during downtime
    logger.info('Checking for recurring transactions due today...');
    await triggerRecurringNow(plutoBot ? plutoBot.getBot() : null);
```

- [ ] **Step 2: Manually verify**

Run: `npm run dev` and check the log output includes `Daily digest scheduler started (runs daily at 22:00 Asia/Singapore)`.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: start the daily digest scheduler on application boot"
```

---

### Task 9: Register the digest test file and run the full suite

**Files:**
- Modify: `package.json:14` (`test` script)

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing new — this makes `npm test` include `src/digest/digest.test.ts`.

- [ ] **Step 1: Update the test script**

In `package.json`, change:

```json
"test": "npx tsx --test src/bot/ai.test.ts src/expense/expense.test.ts src/budget/service.test.ts src/budget/progress.test.ts src/budget/alerts.test.ts src/scheduler/recurring.test.ts",
```

to:

```json
"test": "npx tsx --test src/bot/ai.test.ts src/expense/expense.test.ts src/budget/service.test.ts src/budget/progress.test.ts src/budget/alerts.test.ts src/scheduler/recurring.test.ts src/digest/digest.test.ts",
```

- [ ] **Step 2: Run the full suite**

Run: `npm test`
Expected: PASS — every test file, including the new `src/digest/digest.test.ts`, passes with no network access required.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "test: register src/digest/digest.test.ts in the test script"
```

---

### Task 10: Update the task doc's acceptance criteria

**Files:**
- Modify: `doc/tasks/06-daily-digest.md`

**Interfaces:**
- Consumes: nothing (documentation only).
- Produces: nothing (documentation only).

- [ ] **Step 1: Update the status line and checklist**

In `doc/tasks/06-daily-digest.md`, replace the "Status: not started" paragraph and the acceptance criteria list with:

```markdown
**Status: implemented**, except portfolio net worth and market
movements, which are blocked on PLUTO-04 (Portfolio Tracker) — that
module doesn't exist yet, so the digest's portfolio section is a
permanent "unavailable" placeholder until it's built.

- [x] Scheduler fires at 10 PM SGT daily (Asia/Singapore timezone)
- [x] Message includes today's total spending broken down by category
- [x] Message includes transaction count per category
- [x] Message includes budget status for any category with a budget set
- [ ] Message includes portfolio net worth in SGD — blocked on PLUTO-04
- [ ] Message includes notable stock/crypto movements (> 1% change) — blocked on PLUTO-04
- [x] Message includes any recurring transactions that fired today
- [x] Message is concise, well-formatted, and easy to scan
- [x] If no spending today, message acknowledges it ("No spending
      today")
- [x] Digest still sends even if one data source fails (graceful
      degradation)
```

- [ ] **Step 2: Commit**

```bash
git add doc/tasks/06-daily-digest.md
git commit -m "docs: mark PLUTO-06 daily digest acceptance criteria implemented"
```

---

## Self-Review Notes

- **Spec coverage:** every scope decision in the design doc maps to a task — portfolio stub (Task 3), non-reentrant recurring read (Task 2), category counts (Task 1), AI summary + fallback (Task 5), timezone option (Task 6), no-catchup wiring (Task 8), `/digest` command (Task 7), test registration (Task 9), doc update (Task 10).
- **Placeholder scan:** no TBD/TODO markers; every step has literal code or an exact command.
- **Type consistency:** `DigestData`/`SectionResult<T>` (Task 3) are the single source of truth used unchanged by `formatter.ts` (Task 4), `summary.ts` (Task 5), and `index.ts` (Task 6); `buildDigestMessage`/`triggerDigestNow`/`startDigestScheduler`/`stopDigestScheduler` names match between Task 6's implementation and Tasks 7-8's consumers.
