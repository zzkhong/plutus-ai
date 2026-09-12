import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { toIsoDate } from '../utils/dates';

process.env.DATABASE_URL = './data/test-expense-editing.db';

const testDbPath = path.resolve('./data/test-expense-editing.db');
if (fs.existsSync(testDbPath)) {
  fs.rmSync(testDbPath, { force: true });
}

before(async () => {
  const { runMigrations } = await import('../db/migrate');
  await runMigrations();
});

async function approvedUser(chatId: string): Promise<string> {
  const { createUser, setProvider, completeSetup } = await import('../users/service');
  const { encrypt } = await import('../users/crypto');
  const user = await createUser(chatId);
  await setProvider(user.id, 'gemini');
  await completeSetup(user.id, encrypt('fake-key-for-stubbed-tests'), true);
  return user.id;
}

/** Runs `run` against the categorization stub, counting the LLM calls it makes. */
async function countLlmCalls<T>(run: () => Promise<T>): Promise<{ result: T; calls: number }> {
  const { stubGeminiCategorization } = await import('../testing/geminiStub');
  const restore = stubGeminiCategorization();
  const stubbed = global.fetch;
  let calls = 0;
  global.fetch = ((...args: Parameters<typeof fetch>) => {
    calls += 1;
    return stubbed(...args);
  }) as typeof fetch;
  try {
    const result = await run();
    return { result, calls };
  } finally {
    restore();
  }
}

const pause = () => new Promise((resolve) => setTimeout(resolve, 5));

// --- choosing a category ------------------------------------------------------

test('a new merchant is categorized once, then remembered, corrections included', async () => {
  const { logExpense, setTransactionCategory } = await import('./service');
  const owner = await approvedUser('test-editing-memory-chat');

  const first = await countLlmCalls(() => logExpense(owner, { amount: 6, merchant: 'Toast Box', source: 'text' }));
  assert.equal(first.result.category, 'Food');
  assert.equal(first.calls, 1);

  await setTransactionCategory(owner, first.result.id, 'Groceries');

  const second = await countLlmCalls(() => logExpense(owner, { amount: 7, merchant: 'TOAST BOX ', source: 'text' }));
  assert.equal(second.result.category, 'Groceries', "the user's own correction wins");
  assert.equal(second.calls, 0, 'a remembered merchant needs no LLM call');
});

test("the classifier's category is used for a new merchant, without a second LLM call", async () => {
  const { logExpense } = await import('./service');
  const owner = await approvedUser('test-editing-hint-chat');

  const { result, calls } = await countLlmCalls(() =>
    logExpense(owner, { amount: 30, merchant: 'Popular Bookstore', source: 'text', categoryHint: 'Education' }),
  );

  assert.equal(result.category, 'Education');
  assert.equal(calls, 0);
});

test("the user's history with a merchant beats the classifier's guess", async () => {
  const { logExpense } = await import('./service');
  const owner = await approvedUser('test-editing-history-chat');
  await logExpense(owner, { amount: 5, merchant: 'Cheers', source: 'text', categoryHint: 'Groceries' });

  const { result } = await countLlmCalls(() =>
    logExpense(owner, { amount: 5, merchant: 'Cheers', source: 'text', categoryHint: 'Food' }),
  );

  assert.equal(result.category, 'Groceries');
});

test("one user's merchant history never categorizes another user's expense", async () => {
  const { logExpense } = await import('./service');
  const first = await approvedUser('test-editing-memory-a-chat');
  const second = await approvedUser('test-editing-memory-b-chat');
  await logExpense(first, { amount: 5, merchant: 'Shared Mart', source: 'text', categoryHint: 'Shopping' });

  const { result, calls } = await countLlmCalls(() =>
    logExpense(second, { amount: 5, merchant: 'Shared Mart', source: 'text' }),
  );

  assert.equal(calls, 1, 'the second user has no history, so the categorizer is asked');
  assert.equal(result.category, 'Others');
});

// --- when it was spent --------------------------------------------------------

test('a backdated expense counts toward the day it was spent, and is still the latest logged', async () => {
  const { logExpense, getSpendingSummary, listRecentTransactions } = await import('./service');
  const owner = await approvedUser('test-editing-backdate-chat');
  const march15 = new Date(2026, 2, 15, 12);

  const logged = await logExpense(owner, {
    amount: 20,
    merchant: 'Backdated Cafe',
    source: 'text',
    categoryHint: 'Food',
    spentAt: march15,
  });

  assert.equal(logged.spent_at.getTime(), march15.getTime());
  assert.equal((await getSpendingSummary(owner, 'month', new Date(2026, 2, 20))).total, 2000);
  assert.equal((await getSpendingSummary(owner, 'month', new Date(2026, 3, 5))).total, 0, 'not in April');
  assert.equal((await getSpendingSummary(owner, 'today')).total, 0, 'not today');
  const [latest] = await listRecentTransactions(owner, 1);
  assert.equal(latest.id, logged.id, '"latest" goes by when it was logged');
});

test('an expense saved without spent_at still counts, by when it was logged', async () => {
  // What the previous deployment writes while a new build is migrating.
  const { getSpendingSummary } = await import('./service');
  const { db, transactions } = await import('../db');
  const owner = await approvedUser('test-editing-legacy-row-chat');
  const now = Date.now();
  await db.insert(transactions).values({
    id: randomUUID(),
    user_id: owner,
    amount: 1500,
    currency: 'SGD',
    amount_sgd: 1500,
    merchant: 'Legacy Row',
    category: 'Food',
    source: 'text',
    card_name: 'General',
    created_at: now,
    updated_at: now,
  });

  assert.equal((await getSpendingSummary(owner, 'today')).total, 1500);
});

test('exportCSV picks the year by when the money was spent, and includes that date', async () => {
  const { exportCSV, logExpense } = await import('./service');
  const owner = await approvedUser('test-editing-export-chat');
  const lastYear = new Date(2025, 11, 30, 12);
  await logExpense(owner, { amount: 9, merchant: 'Year End Bar', source: 'text', categoryHint: 'Food', spentAt: lastYear });

  const csv2025 = await exportCSV(owner, 2025);
  const csv2026 = await exportCSV(owner, 2026);

  assert.equal(csv2025.rowCount, 1);
  assert.match(csv2025.content.split('\n')[0], /,spent_at,created_at$/);
  assert.match(csv2025.content, new RegExp(`"${lastYear.getTime()}"`));
  assert.equal(csv2026.rowCount, 0);
});

// --- changing a particular transaction ----------------------------------------

test('correctTransaction changes the transaction it is given, not the latest', async () => {
  const { correctTransaction, getTransaction, logExpense } = await import('./service');
  const owner = await approvedUser('test-editing-target-chat');
  const older = await logExpense(owner, { amount: 10, merchant: 'Older Place', source: 'text', categoryHint: 'Food' });
  const newer = await logExpense(owner, { amount: 20, merchant: 'Newer Place', source: 'text', categoryHint: 'Food' });

  const updated = await correctTransaction(owner, older.id, 'amount', '12');

  assert.equal(updated?.id, older.id);
  assert.equal(updated?.amount, 1200);
  assert.equal((await getTransaction(owner, newer.id))?.amount, 2000);
});

test('a date correction moves the expense to that day; an unreadable date changes nothing', async () => {
  const { correctTransaction, logExpense } = await import('./service');
  const owner = await approvedUser('test-editing-date-chat');
  const logged = await logExpense(owner, { amount: 10, merchant: 'Date Place', source: 'text', categoryHint: 'Food' });

  const moved = await correctTransaction(owner, logged.id, 'date', '2026-03-02');
  assert.equal(toIsoDate(moved!.spent_at), '2026-03-02');

  const unchanged = await correctTransaction(owner, logged.id, 'date', 'not a date');
  assert.equal(toIsoDate(unchanged!.spent_at), '2026-03-02');
});

test("another user's transaction can't be read, recategorized, corrected or deleted by its id", async () => {
  const { correctTransaction, deleteTransaction, getTransaction, logExpense, setTransactionCategory } = await import(
    './service'
  );
  const owner = await approvedUser('test-editing-owner-chat');
  const intruder = await approvedUser('test-editing-intruder-chat');
  const logged = await logExpense(owner, { amount: 10, merchant: 'Private Place', source: 'text', categoryHint: 'Food' });

  assert.equal(await getTransaction(intruder, logged.id), null);
  assert.equal(await setTransactionCategory(intruder, logged.id, 'Travel'), null);
  assert.equal(await correctTransaction(intruder, logged.id, 'amount', '999'), null);
  assert.equal(await deleteTransaction(intruder, logged.id), null);

  const intact = await getTransaction(owner, logged.id);
  assert.equal(intact?.category, 'Food');
  assert.equal(intact?.amount, 1000);
});

test('deleteTransaction removes exactly the transaction it is given', async () => {
  const { deleteTransaction, getTransaction, logExpense } = await import('./service');
  const owner = await approvedUser('test-editing-delete-chat');
  const keep = await logExpense(owner, { amount: 1, merchant: 'Keep', source: 'text', categoryHint: 'Food' });
  const drop = await logExpense(owner, { amount: 2, merchant: 'Drop', source: 'text', categoryHint: 'Food' });

  assert.equal((await deleteTransaction(owner, drop.id))?.merchant, 'Drop');

  assert.equal(await getTransaction(owner, drop.id), null);
  assert.ok(await getTransaction(owner, keep.id));
});

test('listRecentTransactions lists the newest logged first, up to the limit', async () => {
  const { listRecentTransactions, logExpense } = await import('./service');
  const owner = await approvedUser('test-editing-recent-chat');
  await logExpense(owner, { amount: 1, merchant: 'First', source: 'text', categoryHint: 'Food' });
  await pause();
  await logExpense(owner, { amount: 2, merchant: 'Second', source: 'text', categoryHint: 'Food' });
  await pause();
  await logExpense(owner, { amount: 3, merchant: 'Third', source: 'text', categoryHint: 'Food' });

  const recent = await listRecentTransactions(owner, 2);

  assert.deepEqual(
    recent.map((t) => t.merchant),
    ['Third', 'Second'],
  );
});
