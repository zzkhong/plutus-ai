import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { toIsoDate } from '../utils/dates';

process.env.DATABASE_URL = './data/test-income.db';

const testDbPath = path.resolve('./data/test-income.db');
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

const MAY = new Date(2026, 4, 1);
const JUNE = new Date(2026, 5, 1);

// --- service ----------------------------------------------------------------------

test('logIncome stores the SGD value and a tidy label', async () => {
  const { logIncome } = await import('./service');
  const owner = await approvedUser('test-income-log-chat');

  const salary = await logIncome(owner, { amount: 3210, currency: 'MYR', source: 'salary' });
  const unnamed = await logIncome(owner, { amount: 10 });

  assert.equal(salary.amount, 321000);
  assert.equal(salary.amount_sgd, 100000);
  assert.equal(salary.source, 'Salary');
  assert.equal(unnamed.source, 'Income');
  assert.equal(unnamed.currency, 'SGD');
});

test("income totals cover one user's income in the range, and nobody else's", async () => {
  const { getIncomeTotal, listIncomeBetween, logIncome } = await import('./service');
  const owner = await approvedUser('test-income-range-chat');
  const other = await approvedUser('test-income-range-other-chat');
  await logIncome(owner, { amount: 100, receivedAt: new Date(2026, 4, 3) });
  await logIncome(owner, { amount: 50, receivedAt: new Date(2026, 4, 28) });
  await logIncome(owner, { amount: 999, receivedAt: new Date(2026, 5, 1, 9) }); // June
  await logIncome(other, { amount: 777, receivedAt: new Date(2026, 4, 10) });

  assert.equal(await getIncomeTotal(owner, MAY, JUNE), 15000);
  assert.deepEqual(
    (await listIncomeBetween(owner, MAY, JUNE)).map((entry) => entry.amount),
    [5000, 10000],
    'newest first',
  );
});

test("deleteIncome only removes the user's own income", async () => {
  const { deleteIncome, getIncomeTotal, logIncome } = await import('./service');
  const owner = await approvedUser('test-income-delete-chat');
  const intruder = await approvedUser('test-income-delete-intruder-chat');
  const entry = await logIncome(owner, { amount: 40, receivedAt: new Date(2026, 4, 5) });

  assert.equal(await deleteIncome(intruder, entry.id), null);
  assert.equal(await getIncomeTotal(owner, MAY, JUNE), 4000);
  assert.equal((await deleteIncome(owner, entry.id))?.id, entry.id);
  assert.equal(await getIncomeTotal(owner, MAY, JUNE), 0);
});

test("rejecting a user removes their income along with everything else", async () => {
  const { getIncomeTotal, logIncome } = await import('./service');
  const { reject } = await import('../users/service');
  const owner = await approvedUser('test-income-reject-chat');
  await logIncome(owner, { amount: 40, receivedAt: new Date(2026, 4, 5) });

  await reject(owner);

  assert.equal(await getIncomeTotal(owner, MAY, JUNE), 0);
});

// --- chat -------------------------------------------------------------------------

test('an income message records it, with an Undo button', async () => {
  const { buildAssistantReply } = await import('../bot/ai');
  const owner = await approvedUser('test-income-chat-chat');

  const reply = await buildAssistantReply(owner, {
    intent: 'income',
    confidence: 0.9,
    extracted: { amount: 5200, merchant: 'salary' },
    rawText: 'Salary $5200 came in',
  });

  assert.equal(reply.text, 'Recorded S$5200.00 of income from Salary. /month shows your savings rate.');
  const buttons = reply.keyboard!.inline_keyboard.flat() as any[];
  assert.equal(buttons.length, 1);
  assert.match(buttons[0].callback_data, /^i:d:/);
});

test('income the classifier dates to an earlier day is recorded on that day', async () => {
  const { buildAssistantReply } = await import('../bot/ai');
  const { listIncomeBetween } = await import('./service');
  const owner = await approvedUser('test-income-backdate-chat');
  const now = new Date(2026, 4, 20, 10);

  const reply = await buildAssistantReply(
    owner,
    { intent: 'income', confidence: 0.9, extracted: { amount: 800, merchant: 'Freelance', date: '2026-05-15' }, rawText: 'x' },
    { now },
  );

  assert.match(reply.text, /from Freelance, on 15 May 2026\./);
  const [entry] = await listIncomeBetween(owner, MAY, JUNE);
  assert.equal(toIsoDate(entry.received_at), '2026-05-15');
});

test('an income message with no amount asks for one', async () => {
  const { buildAssistantReply } = await import('../bot/ai');
  const owner = await approvedUser('test-income-no-amount-chat');

  const reply = await buildAssistantReply(owner, { intent: 'income', confidence: 0.9, extracted: {}, rawText: 'got paid' });

  assert.match(reply.text, /How much came in/);
});

// --- /month -------------------------------------------------------------------------

test('/month adds income and the savings rate once income is logged', async () => {
  const { handleMonthCommand } = await import('../bot/commands/month');
  const { logExpense } = await import('../expense/service');
  const { logIncome } = await import('./service');
  const owner = await approvedUser('test-income-month-chat');
  const now = new Date(2026, 4, 20, 10);
  await logExpense(owner, { amount: 200, merchant: 'Rent Share', source: 'text', categoryHint: 'Bills', spentAt: new Date(2026, 4, 10, 12) });

  assert.doesNotMatch(await handleMonthCommand(owner, now), /Income/, 'no income, no savings line');

  await logIncome(owner, { amount: 1000, source: 'Salary', receivedAt: new Date(2026, 4, 1, 12) });
  const reply = await handleMonthCommand(owner, now);

  assert.match(reply, /^This month’s spend: S\$200\.00 across 1 transaction\./);
  assert.match(reply, /\n\nIncome: S\$1000\.00 · saved S\$800\.00 \(80%\)\.$/);
});

test('/month says so when spending passed income', async () => {
  const { handleMonthCommand } = await import('../bot/commands/month');
  const { logExpense } = await import('../expense/service');
  const { logIncome } = await import('./service');
  const owner = await approvedUser('test-income-month-over-chat');
  const now = new Date(2026, 4, 20, 10);
  await logExpense(owner, { amount: 1500, merchant: 'Laptop', source: 'text', categoryHint: 'Shopping', spentAt: new Date(2026, 4, 10, 12) });
  await logIncome(owner, { amount: 1000, receivedAt: new Date(2026, 4, 1, 12) });

  assert.match(await handleMonthCommand(owner, now), /Income: S\$1000\.00 · spent S\$500\.00 more than that\./);
});
