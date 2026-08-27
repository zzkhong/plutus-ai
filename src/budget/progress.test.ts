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
