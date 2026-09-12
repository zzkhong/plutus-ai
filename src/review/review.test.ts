import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

process.env.DATABASE_URL = './data/test-review.db';

const testDbPath = path.resolve('./data/test-review.db');
if (fs.existsSync(testDbPath)) {
  fs.rmSync(testDbPath, { force: true });
}

before(async () => {
  const { runMigrations } = await import('../db/migrate');
  await runMigrations();
});

async function approvedUser(chatId: string): Promise<{ id: string; chatId: string }> {
  const { createUser, setProvider, completeSetup } = await import('../users/service');
  const { encrypt } = await import('../users/crypto');
  const user = await createUser(chatId);
  await setProvider(user.id, 'gemini');
  await completeSetup(user.id, encrypt('fake-key-for-stubbed-tests'), true);
  return { id: user.id, chatId };
}

async function spend(userId: string, amount: number, merchant: string, category: string, spentAt: Date) {
  const { logExpense } = await import('../expense/service');
  return logExpense(userId, { amount, merchant, source: 'text', categoryHint: category as any, spentAt });
}

function day(month: number, date: number): Date {
  return new Date(2026, month, date, 12);
}

test('the review compares a month with the one before: categories, merchants, income, budgets', async () => {
  const { collectMonthReview, formatMonthReview } = await import('./index');
  const { logIncome } = await import('../income/service');
  const { setBudget } = await import('../budget/service');
  const owner = await approvedUser('test-review-full-chat');

  // July
  await spend(owner.id, 100, 'Kopi A', 'Food', day(6, 10));
  await spend(owner.id, 50, 'Grab', 'Transport', day(6, 12));
  // August — "kopi a" and "Kopi A" are one merchant
  await spend(owner.id, 50, 'kopi a', 'Food', day(7, 5));
  await spend(owner.id, 100, 'Kopi A', 'Food', day(7, 20));
  await spend(owner.id, 20, 'Grab', 'Transport', day(7, 8));
  await spend(owner.id, 80, 'SP Group', 'Bills', day(7, 15));
  // September — outside the reviewed month
  await spend(owner.id, 999, 'Next Month', 'Shopping', day(8, 2));
  await logIncome(owner.id, { amount: 1000, source: 'Salary', receivedAt: day(7, 1) });
  await setBudget(owner.id, 'Food', 120, 'SGD');
  await setBudget(owner.id, 'Overall', 300, 'SGD');

  const data = await collectMonthReview(owner.id, day(7, 31));

  assert.equal(
    formatMonthReview(data),
    [
      '📅 August 2026 in review',
      '',
      'Spent S$250.00 across 4 expenses, 67% more than July (S$150.00).',
      'Income: S$1000.00 · saved S$750.00 (75%).',
      '',
      'Where it went:',
      '  Food: S$150.00 (↑50%)',
      '  Bills: S$80.00 (new)',
      '  Transport: S$20.00 (↓60%)',
      '',
      'Top merchants:',
      '  Kopi A: S$150.00 (2 times)',
      '  SP Group: S$80.00 (1 time)',
      '  Grab: S$20.00 (1 time)',
      '',
      'Budgets: kept 1 of 2.',
      '  ✅ Overall: S$250.00 of S$300.00',
      '  ❌ Food: S$150.00 of S$120.00, over by S$30.00',
    ].join('\n'),
  );
});

test('a first month has nothing to compare against, so shows no changes', async () => {
  const { collectMonthReview, formatMonthReview } = await import('./index');
  const owner = await approvedUser('test-review-first-month-chat');
  await spend(owner.id, 10, 'Only Shop', 'Shopping', day(7, 3));

  const message = formatMonthReview(await collectMonthReview(owner.id, day(7, 1)));

  assert.match(message, /\nSpent S\$10\.00 across 1 expense\.\n/);
  assert.match(message, /\n {2}Shopping: S\$10\.00\n/);
});

test('an empty month has no review, and /review says so', async () => {
  const { buildMonthReview } = await import('./index');
  const { handleReviewCommand } = await import('../bot/commands/review');
  const owner = await approvedUser('test-review-empty-chat');
  const now = day(7, 1);

  assert.equal(await buildMonthReview(owner.id, now), null);
  assert.equal(
    await handleReviewCommand(owner.id, now),
    "Nothing was logged in July 2026, so there's nothing to review. A review of each month arrives on the 1st.",
  );
});

test('/review reviews the month before the current one', async () => {
  const { handleReviewCommand } = await import('../bot/commands/review');
  const owner = await approvedUser('test-review-command-chat');
  await spend(owner.id, 42, 'June Thing', 'Shopping', day(5, 14));

  const reply = await handleReviewCommand(owner.id, day(6, 1));

  assert.match(reply, /^📅 June 2026 in review\n\nSpent S\$42\.00 across 1 expense\./);
});

test('the monthly job sends each user with last month logged their own review, and skips the rest', async () => {
  const { triggerMonthReviewNow } = await import('./index');
  const { startOfMonth } = await import('../utils/dates');
  const active = await approvedUser('test-review-job-active-chat');
  const idle = await approvedUser('test-review-job-idle-chat');
  const lastMonth = new Date(startOfMonth(new Date(), -1).getTime() + 4 * 86_400_000 + 12 * 3_600_000);
  await spend(active.id, 25, 'Job Cafe', 'Food', lastMonth);

  const sent: Array<{ chatId: string; text: string }> = [];
  const bot = { api: { sendMessage: async (chatId: string, text: string) => sent.push({ chatId, text }) } } as any;
  await triggerMonthReviewNow(bot);

  const toActive = sent.filter((message) => message.chatId === active.chatId);
  assert.equal(toActive.length, 1);
  assert.match(toActive[0].text, /Spent S\$25\.00 across 1 expense/);
  assert.equal(sent.filter((message) => message.chatId === idle.chatId).length, 0);
});

test('the monthly job does nothing without a bot', async () => {
  const { triggerMonthReviewNow } = await import('./index');
  await triggerMonthReviewNow(null);
});
