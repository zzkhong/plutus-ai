import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.DATABASE_URL = './data/test-scheduler-alerts.db';
process.env.TELEGRAM_AUTHORIZED_CHAT_ID = 'test-chat-id';

const testDbPath = path.resolve('./data/test-scheduler-alerts.db');
if (fs.existsSync(testDbPath)) {
  fs.rmSync(testDbPath, { force: true });
}

before(async () => {
  const { runMigrations } = await import('../db/migrate');
  runMigrations();
});

function fakeTransaction(category: string, amountSgdCents: number) {
  const now = new Date();
  return {
    id: randomUUID(),
    amount: amountSgdCents,
    currency: 'SGD' as const,
    amount_sgd: amountSgdCents,
    merchant: 'Test merchant',
    category: category as any,
    source: 'recurring',
    card_name: 'Recurring',
    created_at: now,
    updated_at: now,
  };
}

// checkAlerts (src/budget/alerts.ts) computes month-to-date spend by querying
// the `transactions` table directly (via getSpendingByCategory) — it does not
// read the amount off the Transaction object passed in. In production this is
// always true by the time deliverBudgetAlerts runs, because
// fireRecurringForToday() has already persisted the transaction. Tests that
// expect an alert to fire must persist the transaction first, the same way
// src/budget/alerts.test.ts's own insertTransaction() helper does.
async function insertTransaction(category: string, amountSgdCents: number) {
  const { db, transactions } = await import('../db');
  const txn = fakeTransaction(category, amountSgdCents);
  await db.insert(transactions).values({
    id: txn.id,
    amount: txn.amount,
    currency: txn.currency,
    amount_sgd: txn.amount_sgd,
    merchant: txn.merchant,
    category: txn.category,
    source: txn.source,
    card_name: txn.card_name,
    created_at: txn.created_at.getTime(),
    updated_at: txn.updated_at.getTime(),
  });
  return txn;
}

test('deliverBudgetAlerts does nothing when there are no transactions', async () => {
  const { deliverBudgetAlerts } = await import('./recurring');
  const sent: Array<{ chatId: string; text: string }> = [];
  const fakeApi = { sendMessage: async (chatId: string, text: string) => { sent.push({ chatId, text }); } } as any;

  await deliverBudgetAlerts(fakeApi, []);
  assert.equal(sent.length, 0);
});

test('deliverBudgetAlerts does nothing when no api is available', async () => {
  const { deliverBudgetAlerts } = await import('./recurring');
  await deliverBudgetAlerts(null, [fakeTransaction('Food', 8500)]);
  // No assertion beyond "resolves without throwing" — there's no budget
  // seeded for Food here, and no api to call even if there were, so this
  // test doesn't need the transaction persisted (unlike the test below).
});

test('deliverBudgetAlerts sends a message when a transaction crosses a threshold', async () => {
  const { setBudget } = await import('../budget/service');
  const { deliverBudgetAlerts } = await import('./recurring');

  await setBudget('Entertainment', 100, 'SGD');
  const transaction = await insertTransaction('Entertainment', 8500);

  const sent: Array<{ chatId: string; text: string }> = [];
  const fakeApi = { sendMessage: async (chatId: string, text: string) => { sent.push({ chatId, text }); } } as any;

  await deliverBudgetAlerts(fakeApi, [transaction]);

  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, 'test-chat-id');
  assert.match(sent[0].text, /Entertainment/);
});
