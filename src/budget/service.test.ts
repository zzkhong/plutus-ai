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
