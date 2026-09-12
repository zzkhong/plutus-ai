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
  await runMigrations();
  const { createUser, setProvider, completeSetup } = await import('../users/service');
  const { encrypt } = await import('../users/crypto');
  const user = await createUser('test-expense-chat');
  userId = user.id;
  await setProvider(userId, 'gemini');
  await completeSetup(userId, encrypt('fake-key-for-stubbed-tests'), true);
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

test('exportCSV builds the CSV in memory, scoped to the calling user', async () => {
  const { exportCSV, logExpense } = await import('./index');
  const { createUser } = await import('../users/service');
  const year = new Date().getFullYear();

  await logExpense(userId, { amount: 7.25, merchant: 'Export Mine Cafe', source: 'text' });
  const otherUser = await createUser('test-expense-export-other-chat');
  await logExpense(otherUser.id, { amount: 3, merchant: 'Export Theirs Cafe', source: 'text' });

  const csv = await exportCSV(userId, year);

  assert.equal(csv.year, year);
  assert.equal(csv.filename, `plutus-expenses-${year}.csv`);
  const lines = csv.content.trim().split('\n');
  assert.match(lines[0], /^id,amount,currency,amount_sgd,merchant/);
  assert.equal(lines.length - 1, csv.rowCount);
  assert.match(csv.content, /Export Mine Cafe/);
  assert.doesNotMatch(csv.content, /Export Theirs Cafe/);
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

test('fireRecurringForToday is idempotent within a day — running it again logs nothing new', async () => {
  const { createRecurring, fireRecurringForToday, getRecurringFiredToday } = await import('./index');
  await createRecurring(userId, {
    amount: 1200,
    currency: 'SGD',
    merchant: 'Idempotent Gym',
    category: 'Health',
    day_of_month: new Date().getDate(),
    is_active: true,
  });

  const first = await fireRecurringForToday(userId);
  assert.ok(first.some((t) => t.merchant === 'Idempotent Gym'));

  // The standalone process runs the job at startup and at midnight, and a
  // cron call can be delivered twice — neither may double-log the charge.
  const second = await fireRecurringForToday(userId);
  assert.ok(!second.some((t) => t.merchant === 'Idempotent Gym'));

  const firedToday = await getRecurringFiredToday(userId);
  assert.equal(firedToday.filter((t) => t.merchant === 'Idempotent Gym').length, 1);
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

test("fireRecurringForToday logs a charge for a day the month doesn't have on the month's last day", async () => {
  const { createUser } = await import('../users/service');
  const { createRecurring, fireRecurringForToday } = await import('./index');
  const owner = await createUser('test-expense-month-end-chat');
  await createRecurring(owner.id, {
    amount: 30,
    currency: 'SGD',
    merchant: 'Month End Rent',
    category: 'Bills',
    day_of_month: 31,
    is_active: true,
  });

  // September has 30 days: nothing on the 29th, the charge on the 30th.
  assert.equal((await fireRecurringForToday(owner.id, new Date(2026, 8, 29, 9, 0))).length, 0);
  const onLastDay = await fireRecurringForToday(owner.id, new Date(2026, 8, 30, 9, 0));
  assert.deepEqual(onLastDay.map((t) => t.merchant), ['Month End Rent']);
});

test('fireRecurringForToday does not fire a 31st charge early in a month that has a 31st', async () => {
  const { createUser } = await import('../users/service');
  const { createRecurring, fireRecurringForToday } = await import('./index');
  const owner = await createUser('test-expense-month-31-chat');
  await createRecurring(owner.id, {
    amount: 30,
    currency: 'SGD',
    merchant: 'October Rent',
    category: 'Bills',
    day_of_month: 31,
    is_active: true,
  });

  assert.equal((await fireRecurringForToday(owner.id, new Date(2026, 9, 30, 9, 0))).length, 0);
  assert.equal((await fireRecurringForToday(owner.id, new Date(2026, 9, 31, 9, 0))).length, 1);
});
