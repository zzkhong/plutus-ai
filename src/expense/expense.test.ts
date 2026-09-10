import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { stubGeminiCategorization } from '../testing/geminiStub';

process.env.DATABASE_URL = './data/test-plutus.db';

const testDbPath = path.resolve('./data/test-plutus.db');
if (fs.existsSync(testDbPath)) {
  fs.rmSync(testDbPath, { force: true });
}

let restoreGeminiStub: () => void;
let userId: string;

before(async () => {
  restoreGeminiStub = stubGeminiCategorization();
  const { runMigrations } = await import('../db/migrate');
  runMigrations();
  const { createUser } = await import('../users/service');
  const user = await createUser('test-expense-chat');
  userId = user.id;
});

after(() => {
  restoreGeminiStub();
});

test('logExpense stores SGD-normalized value and detects local categories', async () => {
  const { logExpense, getSpendingSummary } = await import('./index');
  const kopi = await logExpense(userId, {
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

  const grab = await logExpense(userId, {
    amount: 1200,
    currency: 'SGD',
    merchant: 'Grab ride',
    cardName: 'DBS Visa',
    note: 'grab home',
    source: 'apple_pay',
  });

  assert.equal(grab.category, 'Transport');
  assert.ok(grab.amount_sgd > 0);

  const summary = await getSpendingSummary(userId, 'month');
  assert.ok(summary.total > 0);
  assert.ok(summary.byCategory.Food >= 0 || summary.byCategory.Transport >= 0);
});

test('undoLastTransaction removes the most recent entry', async () => {
  const { getSpendingSummary, undoLastTransaction } = await import('./index');
  const before = await getSpendingSummary(userId, 'month');
  const undone = await undoLastTransaction(userId);

  assert.ok(undone);
  const after = await getSpendingSummary(userId, 'month');
  assert.ok(after.total <= before.total);

  // Drain the second transaction so Test 3's isolation check is against a genuinely empty set
  await undoLastTransaction(userId);
});

test('undoLastTransaction only ever affects the calling user', async () => {
  const { createUser } = await import('../users/service');
  const { logExpense, undoLastTransaction, getSpendingSummary } = await import('./index');
  const otherUser = await createUser('test-expense-other-chat');

  await logExpense(otherUser.id, { amount: 5, currency: 'SGD', merchant: 'Other user item', source: 'text' });
  const undone = await undoLastTransaction(userId); // userId has no transactions left after the previous test's undo

  assert.equal(undone, null);
  const otherSummary = await getSpendingSummary(otherUser.id, 'month');
  assert.equal(otherSummary.count, 1); // untouched
});

test('correctLastTransaction updates the calling user\'s most recent transaction', async () => {
  const { logExpense, correctLastTransaction } = await import('./index');
  await logExpense(userId, { amount: 20, currency: 'SGD', merchant: 'Original merchant', source: 'text' });

  const corrected = await correctLastTransaction(userId, 'merchant', 'Corrected merchant');
  assert.ok(corrected);
  assert.equal(corrected!.merchant, 'Corrected merchant');
});

test('getSpendingSummary tracks a per-category transaction count', async () => {
  const { logExpense, getSpendingSummary } = await import('./index');
  const before = await getSpendingSummary(userId, 'today');
  const beforeCount = before.byCategoryCount.Entertainment ?? 0;

  await logExpense(userId, { amount: 10, currency: 'SGD', merchant: 'Netflix subscription', source: 'text' });
  await logExpense(userId, { amount: 10, currency: 'SGD', merchant: 'Netflix subscription', source: 'text' });

  const after = await getSpendingSummary(userId, 'today');
  assert.equal(after.byCategoryCount.Entertainment, beforeCount + 2);

  const totalFromCounts = Object.values(after.byCategoryCount).reduce((sum, n) => sum + n, 0);
  assert.equal(totalFromCounts, after.count);
});

test('exportCSV writes a per-user file scoped to that user\'s transactions', async () => {
  const { exportCSV } = await import('./index');
  const filePath = await exportCSV(userId, new Date().getFullYear());
  assert.ok(fs.existsSync(filePath));
  assert.match(filePath, new RegExp(userId));
});

test('recurring transactions can be fired for today', async () => {
  const { createRecurring, fireRecurringForToday } = await import('./index');
  const recurring = await createRecurring(userId, {
    amount: 2500,
    currency: 'SGD',
    merchant: 'Netflix',
    category: 'Entertainment',
    day_of_month: new Date().getDate(),
    is_active: true,
  });

  const fired = await fireRecurringForToday(userId);
  assert.ok(fired.some((item) => item.merchant === recurring.merchant));
});

test('getRecurringFiredToday reports already-fired recurring transactions without inserting new ones', async () => {
  const { createRecurring, fireRecurringForToday, getRecurringFiredToday } = await import('./index');
  const recurring = await createRecurring(userId, {
    amount: 500,
    currency: 'SGD',
    merchant: 'Spotify',
    category: 'Entertainment',
    day_of_month: new Date().getDate(),
    is_active: true,
  });

  await fireRecurringForToday(userId);

  const first = await getRecurringFiredToday(userId);
  const second = await getRecurringFiredToday(userId);

  assert.equal(first.length, second.length);
  assert.ok(first.some((t) => t.merchant === recurring.merchant));
  assert.ok(first.every((t) => t.source === 'recurring'));
});

test('fireRecurringForToday only fires the calling user\'s own due recurring entries', async () => {
  const { createUser } = await import('../users/service');
  const { createRecurring, fireRecurringForToday } = await import('./index');
  const otherUser = await createUser('test-expense-recurring-other-chat');

  await createRecurring(otherUser.id, {
    amount: 999,
    currency: 'SGD',
    merchant: 'Other User Gym',
    category: 'Health',
    day_of_month: new Date().getDate(),
    is_active: true,
  });

  const firedForUserId = await fireRecurringForToday(userId);
  assert.ok(!firedForUserId.some((t) => t.merchant === 'Other User Gym'));

  const firedForOtherUser = await fireRecurringForToday(otherUser.id);
  assert.ok(firedForOtherUser.some((t) => t.merchant === 'Other User Gym'));
});

test('removeRecurring only deletes when the id belongs to the calling user', async () => {
  const { createUser } = await import('../users/service');
  const { createRecurring, removeRecurring, listRecurring } = await import('./index');
  const otherUser = await createUser('test-expense-remove-recurring-other-chat');

  const theirs = await createRecurring(otherUser.id, {
    amount: 100,
    currency: 'SGD',
    merchant: 'Their Subscription',
    category: 'Entertainment',
    day_of_month: 1,
    is_active: true,
  });

  await removeRecurring(userId, theirs.id); // wrong user — should not delete

  const stillThere = await listRecurring(otherUser.id);
  assert.ok(stillThere.some((r) => r.id === theirs.id));

  await removeRecurring(otherUser.id, theirs.id); // correct user
  const gone = await listRecurring(otherUser.id);
  assert.ok(!gone.some((r) => r.id === theirs.id));
});
