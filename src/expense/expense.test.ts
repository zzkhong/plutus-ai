import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

process.env.DATABASE_URL = './data/test-plutus.db';

const testDbPath = path.resolve('./data/test-plutus.db');
if (fs.existsSync(testDbPath)) {
  fs.rmSync(testDbPath, { force: true });
}

test('logExpense stores SGD-normalized value and detects local categories', async () => {
  const { logExpense, getSpendingSummary } = await import('./index');
  const kopi = await logExpense({
    amount: 450,
    currency: 'MYR',
    merchant: 'Kopi tiam',
    cardName: 'Maybank',
    note: 'kopi and toast',
    source: 'text',
  });

  assert.equal(kopi.category, 'Food');
  assert.equal(kopi.currency, 'MYR');
  assert.ok(kopi.amount_sgd > 0);

  const grab = await logExpense({
    amount: 1200,
    currency: 'SGD',
    merchant: 'Grab ride',
    cardName: 'DBS Visa',
    note: 'grab home',
    source: 'apple_pay',
  });

  assert.equal(grab.category, 'Transport');
  assert.ok(grab.amount_sgd > 0);

  const summary = await getSpendingSummary('month');
  assert.ok(summary.total > 0);
  assert.ok(summary.byCategory.Food >= 0 || summary.byCategory.Transport >= 0);
});

test('undoLastTransaction removes the most recent entry', async () => {
  const { getSpendingSummary, undoLastTransaction } = await import('./index');
  const before = await getSpendingSummary('month');
  const undone = await undoLastTransaction();

  assert.ok(undone);
  const after = await getSpendingSummary('month');
  assert.ok(after.total <= before.total);
});

test('recurring transactions can be fired for today', async () => {
  const { createRecurring, fireRecurringForToday } = await import('./index');
  const recurring = await createRecurring({
    amount: 2500,
    currency: 'SGD',
    merchant: 'Netflix',
    category: 'Entertainment',
    day_of_month: new Date().getDate(),
    is_active: true,
  });

  const fired = await fireRecurringForToday();
  assert.ok(fired.some((item) => item.merchant === recurring.merchant));
});
