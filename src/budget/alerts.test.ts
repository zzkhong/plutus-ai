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

async function insertTransaction(forUserId: string, category: string, amountSgdCents: number) {
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
  const txn = await insertTransaction(userId, 'Travel', 1000);

  const alert = await checkAlerts(userId, txn);
  assert.equal(alert, null);
});

test('checkAlerts fires once at 80% and not again for a later transaction under 100%', async () => {
  const { setBudget } = await import('./service');
  const { checkAlerts } = await import('./alerts');

  await setBudget(userId, 'Food', 100, 'SGD'); // S$100 budget

  const first = await insertTransaction(userId, 'Food', 8500); // 85%
  const firstAlert = await checkAlerts(userId, first);
  assert.ok(firstAlert);
  assert.equal(firstAlert!.threshold, 80);

  const second = await insertTransaction(userId, 'Food', 100); // 86%, still under 100%
  const secondAlert = await checkAlerts(userId, second);
  assert.equal(secondAlert, null);
});

test('checkAlerts fires the 100% alert once when spend crosses it', async () => {
  const { setBudget } = await import('./service');
  const { checkAlerts } = await import('./alerts');

  await setBudget(userId, 'Shopping', 100, 'SGD');

  const pushOver = await insertTransaction(userId, 'Shopping', 10500); // 105%
  const alert = await checkAlerts(userId, pushOver);
  assert.ok(alert);
  assert.equal(alert!.threshold, 100);

  const again = await insertTransaction(userId, 'Shopping', 100);
  const repeat = await checkAlerts(userId, again);
  assert.equal(repeat, null);
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

  assert.ok(alert);
  assert.equal(alert!.threshold, 80);
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
  assert.equal(alert, null);
});
