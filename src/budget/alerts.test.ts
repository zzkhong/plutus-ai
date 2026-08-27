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
