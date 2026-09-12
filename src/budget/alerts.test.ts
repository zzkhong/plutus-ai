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

let userId: string;

before(async () => {
  const { runMigrations } = await import('../db/migrate');
  await runMigrations();
  const { createUser } = await import('../users/service');
  const user = await createUser('test-budget-alerts-chat');
  userId = user.id;
});

async function insertTransaction(forUserId: string, category: string, amountSgdCents: number, spentAt = new Date()) {
  const { db, transactions } = await import('../db');
  const now = Date.now();
  const id = randomUUID();

  await db.insert(transactions).values({
    id,
    user_id: forUserId,
    amount: amountSgdCents,
    currency: 'SGD',
    amount_sgd: amountSgdCents,
    merchant: 'Test merchant',
    category,
    source: 'text',
    card_name: 'Test',
    spent_at: spentAt.getTime(),
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
    spent_at: spentAt,
    created_at: new Date(now),
    updated_at: new Date(now),
  };
}

test('checkAlerts returns null when there is no budget for the category', async () => {
  const { checkAlerts } = await import('./alerts');
  const txn = await insertTransaction(userId, 'Travel', 1000);

  const alert = await checkAlerts(userId, txn);
  assert.deepEqual(alert, []);
});

test('checkAlerts fires once at 80% and not again for a later transaction under 100%', async () => {
  const { setBudget } = await import('./service');
  const { checkAlerts } = await import('./alerts');

  await setBudget(userId, 'Food', 100, 'SGD'); // S$100 budget

  const first = await insertTransaction(userId, 'Food', 8500); // 85%
  const firstAlert = await checkAlerts(userId, first);
  assert.deepEqual(firstAlert.map((a) => a.threshold), [80]);

  const second = await insertTransaction(userId, 'Food', 100); // 86%, still under 100%
  const secondAlert = await checkAlerts(userId, second);
  assert.deepEqual(secondAlert, []);
});

test('checkAlerts fires the 100% alert once when spend crosses it', async () => {
  const { setBudget } = await import('./service');
  const { checkAlerts } = await import('./alerts');

  await setBudget(userId, 'Shopping', 100, 'SGD');

  const pushOver = await insertTransaction(userId, 'Shopping', 10500); // 105%
  const alert = await checkAlerts(userId, pushOver);
  assert.deepEqual(alert.map((a) => a.threshold), [100]);

  const again = await insertTransaction(userId, 'Shopping', 100);
  const repeat = await checkAlerts(userId, again);
  assert.deepEqual(repeat, []);
});

test('checkAlerts re-fires in a new month even if already sent in a previous month', async () => {
  const { setBudget, findBudgetByCategory } = await import('./service');
  const { checkAlerts } = await import('./alerts');
  const { db } = await import('../db');
  const { budget_alerts } = await import('../db/schema');

  await setBudget(userId, 'Bills', 100, 'SGD');
  const budget = await findBudgetByCategory(userId, 'Bills');
  assert.ok(budget);

  await db.insert(budget_alerts).values({
    id: randomUUID(),
    user_id: userId,
    budget_id: budget!.id,
    threshold: 80,
    month: '2000-01',
    sent_at: Date.now(),
  });

  const txn = await insertTransaction(userId, 'Bills', 8500);
  const alert = await checkAlerts(userId, txn);

  assert.deepEqual(alert.map((a) => a.threshold), [80]);
});

test('checkAlerts never fires off another user\'s budget or spending', async () => {
  const { createUser } = await import('../users/service');
  const { setBudget } = await import('./service');
  const { checkAlerts } = await import('./alerts');
  const otherUser = await createUser('test-budget-alerts-other-chat');

  await setBudget(otherUser.id, 'Health', 100, 'SGD');
  // userId (the calling user) has no 'Health' budget at all.
  const txn = await insertTransaction(userId, 'Health', 9000);

  const alert = await checkAlerts(userId, txn);
  assert.deepEqual(alert, []);
});

// --- the overall budget, pace warnings, and backdated expenses ---------------------

async function freshUser(chatId: string): Promise<string> {
  const { createUser } = await import('../users/service');
  return (await createUser(chatId)).id;
}

const june = (date: number) => new Date(2026, 5, date, 12);

test('the overall budget alerts on all spending together', async () => {
  const { setBudget } = await import('./service');
  const { checkAlerts } = await import('./alerts');
  const owner = await freshUser('test-budget-alerts-overall-chat');
  await setBudget(owner, 'Overall', 100, 'SGD');

  await insertTransaction(owner, 'Food', 5000);
  const txn = await insertTransaction(owner, 'Transport', 3500); // 85% overall, no Transport budget

  const alerts = await checkAlerts(owner, txn);
  assert.deepEqual(
    alerts.map((a) => [a.category, a.threshold]),
    [['Overall', 80]],
  );
  assert.match(alerts[0].message, /Overall budget alert: you've used 80% \(S\$85\.00 \/ S\$100\.00\)/);
});

test('one expense can trigger its category alert and an overall pace warning together', async () => {
  const { setBudget } = await import('./service');
  const { checkAlerts } = await import('./alerts');
  const owner = await freshUser('test-budget-alerts-both-chat');
  await setBudget(owner, 'Food', 50, 'SGD');
  await setBudget(owner, 'Overall', 60, 'SGD');

  // S$45 by 20 June: Food is at 90%; overall is at 75%, heading for S$67.50 of S$60.
  const txn = await insertTransaction(owner, 'Food', 4500, june(15));
  const alerts = await checkAlerts(owner, txn, june(20));

  assert.deepEqual(
    alerts.map((a) => [a.category, a.threshold]),
    [
      ['Food', 80],
      ['Overall', 'pace'],
    ],
  );
});

test('a pace warning comes once, when the month is heading well past the budget', async () => {
  const { setBudget } = await import('./service');
  const { checkAlerts } = await import('./alerts');
  const owner = await freshUser('test-budget-alerts-pace-chat');
  await setBudget(owner, 'Groceries', 300, 'SGD');

  // S$150 by 10 June is 50% used, but heading for S$450.
  const first = await insertTransaction(owner, 'Groceries', 15000, june(5));
  const alerts = await checkAlerts(owner, first, june(10));
  assert.deepEqual(alerts.map((a) => a.threshold), ['pace']);
  assert.equal(
    alerts[0].message,
    "📈 Groceries budget: at this pace you'll spend about S$450.00 of your S$300.00 this month (S$150.00 so far, 20 days left).",
  );

  const second = await insertTransaction(owner, 'Groceries', 1000, june(10));
  assert.deepEqual(await checkAlerts(owner, second, june(10)), [], 'once a month');
});

test('no pace warning in the first week, or when the pace only brushes the budget', async () => {
  const { setBudget } = await import('./service');
  const { checkAlerts } = await import('./alerts');
  const owner = await freshUser('test-budget-alerts-early-chat');
  await setBudget(owner, 'Shopping', 300, 'SGD');
  await setBudget(owner, 'Health', 300, 'SGD');

  const early = await insertTransaction(owner, 'Shopping', 15000, june(3));
  assert.deepEqual(await checkAlerts(owner, early, june(5)), [], 'too early in the month to project');

  // S$105 by 10 June heads for S$315 — over, but within the 10% margin.
  const close = await insertTransaction(owner, 'Health', 10500, june(8));
  assert.deepEqual(await checkAlerts(owner, close, june(10)), []);
});

test('an expense dated in an earlier month triggers no alert this month', async () => {
  const { setBudget } = await import('./service');
  const { checkAlerts } = await import('./alerts');
  const owner = await freshUser('test-budget-alerts-backdated-chat');
  await setBudget(owner, 'Travel', 100, 'SGD');

  const lastMonth = await insertTransaction(owner, 'Travel', 50000, new Date(2026, 4, 30, 12));

  assert.deepEqual(await checkAlerts(owner, lastMonth, june(2)), []);
});

test('getBudgetStatus counts everything against the overall budget, lists it first, and projects the month', async () => {
  const { setBudget } = await import('./service');
  const { getBudgetStatus } = await import('./progress');
  const owner = await freshUser('test-budget-alerts-status-chat');
  await setBudget(owner, 'Food', 100, 'SGD');
  await setBudget(owner, 'Overall', 500, 'SGD');
  await insertTransaction(owner, 'Food', 4000, june(4));
  await insertTransaction(owner, 'Bills', 6000, june(6));

  const statuses = await getBudgetStatus(owner, june(10));
  assert.deepEqual(
    statuses.map((s) => [s.category, s.spent_sgd, s.projected_sgd]),
    [
      ['Overall', 10000, 30000],
      ['Food', 4000, 12000],
    ],
  );

  const early = await getBudgetStatus(owner, june(6));
  assert.equal(early[0].projected_sgd, undefined, 'no projection in the first week');
});
