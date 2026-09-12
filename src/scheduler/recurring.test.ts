import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.DATABASE_URL = './data/test-scheduler-alerts.db';

const testDbPath = path.resolve('./data/test-scheduler-alerts.db');
if (fs.existsSync(testDbPath)) {
  fs.rmSync(testDbPath, { force: true });
}

let userId: string;

before(async () => {
  const { runMigrations } = await import('../db/migrate');
  await runMigrations();
  const { createUser } = await import('../users/service');
  const user = await createUser('test-chat-id');
  userId = user.id;
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
    spent_at: now,
    created_at: now,
    updated_at: now,
  };
}

// checkAlerts (src/budget/alerts.ts) computes month-to-date spend by querying
// the `transactions` table directly (via getSpendingByCategory) — it does not
// read the amount off the Transaction object passed in. Tests that expect an
// alert to fire must persist the transaction first, the same way
// src/budget/alerts.test.ts's own insertTransaction() helper does.
async function insertTransaction(category: string, amountSgdCents: number) {
  const { db, transactions } = await import('../db');
  const txn = fakeTransaction(category, amountSgdCents);
  await db.insert(transactions).values({
    id: txn.id,
    user_id: userId,
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

  await deliverBudgetAlerts(fakeApi, 'test-chat-id', userId, []);
  assert.equal(sent.length, 0);
});

test('deliverBudgetAlerts does nothing when no api is available', async () => {
  const { deliverBudgetAlerts } = await import('./recurring');
  await deliverBudgetAlerts(null, 'test-chat-id', userId, [fakeTransaction('Food', 8500)]);
});

test('deliverBudgetAlerts sends a message when a transaction crosses a threshold', async () => {
  const { setBudget } = await import('../budget/service');
  const { deliverBudgetAlerts } = await import('./recurring');

  await setBudget(userId, 'Entertainment', 100, 'SGD');
  const transaction = await insertTransaction('Entertainment', 8500);

  const sent: Array<{ chatId: string; text: string }> = [];
  const fakeApi = { sendMessage: async (chatId: string, text: string) => { sent.push({ chatId, text }); } } as any;

  await deliverBudgetAlerts(fakeApi, 'test-chat-id', userId, [transaction]);

  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, 'test-chat-id');
  assert.match(sent[0].text, /Entertainment/);
});

test('deliverBudgetAlerts keeps processing later transactions after sendMessage throws for an earlier one', async () => {
  const { setBudget } = await import('../budget/service');
  const { deliverBudgetAlerts } = await import('./recurring');

  await setBudget(userId, 'Bills', 100, 'SGD');
  await setBudget(userId, 'Health', 100, 'SGD');

  const failing = await insertTransaction('Bills', 8500); // crosses 80%, send will throw
  const healthy = await insertTransaction('Health', 8500); // also crosses 80%, send should succeed

  const sent: Array<{ chatId: string; text: string }> = [];
  const fakeApi = {
    sendMessage: async (chatId: string, text: string) => {
      if (text.includes('Bills')) {
        throw new Error('simulated Telegram send failure');
      }
      sent.push({ chatId, text });
    },
  } as any;

  await assert.doesNotReject(() => deliverBudgetAlerts(fakeApi, 'test-chat-id', userId, [failing, healthy]));

  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Health/);
});

test('triggerRecurringNow fires due recurring entries once per approved user', async () => {
  const { createUser, approve, setProvider } = await import('../users/service');
  const { createRecurring, getRecurringFiredToday } = await import('../expense/service');
  const { triggerRecurringNow } = await import('./recurring');

  const userA = await createUser('test-scheduler-user-a');
  await setProvider(userA.id, 'gemini');
  await approve(userA.id);
  await createRecurring(userA.id, {
    amount: 10,
    currency: 'SGD',
    merchant: 'A Subscription',
    category: 'Entertainment', // explicit category — no Gemini call needed to fire this
    day_of_month: new Date().getDate(),
    is_active: true,
  });

  const sent: Array<{ chatId: string; text: string }> = [];
  const fakeBot = {
    api: { sendMessage: async (chatId: string, text: string) => { sent.push({ chatId, text }); } },
  } as any;

  await assert.doesNotReject(() => triggerRecurringNow(fakeBot));

  const fired = await getRecurringFiredToday(userA.id);
  assert.ok(fired.some((t) => t.merchant === 'A Subscription'));
});

test('triggerRecurringNow does not let one user\'s failure block another user\'s recurring entries from firing', async () => {
  const { createUser, approve, setProvider } = await import('../users/service');
  const { createRecurring, getRecurringFiredToday } = await import('../expense/service');
  const { triggerRecurringNow } = await import('./recurring');

  const failingUser = await createUser('test-scheduler-failing-user');
  await setProvider(failingUser.id, 'gemini');
  await approve(failingUser.id);
  await createRecurring(failingUser.id, {
    amount: 5,
    currency: 'SGD',
    merchant: 'Failing Sub',
    category: 'Bills',
    day_of_month: new Date().getDate(),
    is_active: true,
  });

  const healthyUser = await createUser('test-scheduler-healthy-user');
  await setProvider(healthyUser.id, 'gemini');
  await approve(healthyUser.id);
  await createRecurring(healthyUser.id, {
    amount: 5,
    currency: 'SGD',
    merchant: 'Healthy Sub',
    category: 'Bills',
    day_of_month: new Date().getDate(),
    is_active: true,
  });

  const fakeBot = {
    api: {
      sendMessage: async (chatId: string) => {
        if (chatId === 'test-scheduler-failing-user') {
          throw new Error('simulated send failure for the failing user');
        }
      },
    },
  } as any;

  await assert.doesNotReject(() => triggerRecurringNow(fakeBot));

  const healthyFired = await getRecurringFiredToday(healthyUser.id);
  assert.ok(healthyFired.some((t) => t.merchant === 'Healthy Sub'));
});
