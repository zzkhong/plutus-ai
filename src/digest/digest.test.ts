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
