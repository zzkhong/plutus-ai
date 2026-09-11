import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

process.env.DATABASE_URL = './data/test-digest.db';

const testDbPath = path.resolve('./data/test-digest.db');
if (fs.existsSync(testDbPath)) {
  fs.rmSync(testDbPath, { force: true });
}

const originalFetch = global.fetch;

let userId: string;
const digestChatId = 'test-digest-chat';

before(async () => {
  const { runMigrations } = await import('../db/migrate');
  await runMigrations();
  const { createUser, setProvider, completeSetup } = await import('../users/service');
  const { encrypt } = await import('../users/crypto');
  const user = await createUser(digestChatId);
  await setProvider(user.id, 'gemini');
  await completeSetup(user.id, encrypt('fake-key-for-tests'), true);
  userId = user.id;

  // No test in this file needs a real Gemini call — stub fetch so
  // generateSummaryLine deterministically falls back to its rule-based
  // line, keeping the suite network-free by default.
  global.fetch = (() => {
    throw new Error('simulated network failure');
  }) as typeof fetch;
});

after(() => {
  global.fetch = originalFetch;
});

test('settle degrades a rejected promise into a SectionResult error without throwing', async () => {
  const { settle } = await import('./aggregator');
  const result = await settle('testSection', Promise.reject(new Error('boom')));
  assert.deepEqual(result, { error: 'boom' });
});

test('settle passes a resolved value through unchanged', async () => {
  const { settle } = await import('./aggregator');
  const result = await settle('testSection', Promise.resolve({ ok: true }));
  assert.deepEqual(result, { ok: true });
});

test('collectDigestData returns real data for all live sources and a permanent portfolio stub', async () => {
  const { collectDigestData } = await import('./aggregator');
  const data = await collectDigestData(userId);

  assert.ok('total' in (data.spending as object));
  assert.ok(Array.isArray(data.recurringFired));
  assert.ok(Array.isArray(data.budgetStatuses));
  // No holdings on file for this user, so the portfolio section is the
  // friendly empty state — not an error, and no LLM call is spent.
  const { NO_HOLDINGS_MESSAGE } = await import('../portfolio/advice');
  assert.equal(data.portfolio, NO_HOLDINGS_MESSAGE);
});

function emptySpending() {
  return { period: 'today' as const, total: 0, count: 0, byCategory: {}, byCategoryCount: {}, topExpenses: [] };
}

test('formatDigestMessage renders "no spending today" when total is zero', async () => {
  const { formatDigestMessage } = await import('./formatter');

  const data = {
    spending: emptySpending(),
    recurringFired: [],
    budgetStatuses: [],
    portfolio: { error: 'price fetch failed' },
  };

  const message = formatDigestMessage(data as any, 'All good.');
  assert.match(message, /no spending today/i);
});

test('formatDigestMessage omits Budget/Auto-logged when empty and renders them when present', async () => {
  const { formatDigestMessage } = await import('./formatter');

  const baseData = {
    spending: { period: 'today' as const, total: 1000, count: 1, byCategory: { Food: 1000 }, byCategoryCount: { Food: 1 }, topExpenses: [] },
    recurringFired: [],
    budgetStatuses: [],
    portfolio: { error: 'price fetch failed' },
  };

  const emptyMessage = formatDigestMessage(baseData as any, 'All good.');
  assert.doesNotMatch(emptyMessage, /Auto-logged/);
  assert.doesNotMatch(emptyMessage, /Budget:/);

  const filledData = {
    ...baseData,
    recurringFired: [
      {
        id: '1',
        amount: 1500,
        currency: 'SGD',
        amount_sgd: 1500,
        merchant: 'Netflix',
        category: 'Entertainment',
        source: 'recurring',
        card_name: 'Recurring',
        created_at: new Date(),
        updated_at: new Date(),
      },
    ],
    budgetStatuses: [
      {
        category: 'Food',
        budget_amount: 10000,
        budget_currency: 'SGD',
        budget_sgd: 10000,
        spent_sgd: 6250,
        percentage: 62.5,
        remaining_sgd: 3750,
        days_left_in_month: 3,
      },
    ],
  };

  const filledMessage = formatDigestMessage(filledData as any, 'All good.');
  assert.match(filledMessage, /Auto-logged: S\$15\.00 Netflix \(recurring\)/);
  assert.match(filledMessage, /Budget: Food 62\.5% used \(3 days left\)/);
});

test('formatDigestMessage renders a failed portfolio section as unavailable', async () => {
  const { formatDigestMessage } = await import('./formatter');

  const data = {
    spending: emptySpending(),
    recurringFired: [],
    budgetStatuses: [],
    portfolio: { error: 'price fetch failed' },
  };

  const message = formatDigestMessage(data as any, 'All good.');
  assert.match(message, /Portfolio: unavailable \(price fetch failed\)/);
});

test('formatDigestMessage renders portfolio advice text under a Portfolio heading', async () => {
  const { formatDigestMessage } = await import('./formatter');

  const data = {
    spending: emptySpending(),
    recurringFired: [],
    budgetStatuses: [],
    portfolio: 'Markets were flat today. Hold.',
  };

  const message = formatDigestMessage(data as any, 'All good.');
  assert.match(message, /Portfolio:\nMarkets were flat today\. Hold\./);
});

test('collectDigestData degrades the portfolio section alone when advice generation fails', async () => {
  const { collectDigestData } = await import('./aggregator');
  const { addHolding } = await import('../portfolio/service');

  // A user with a holding reaches the provider, which this file has stubbed
  // to throw — the section must carry the error while the rest still fills in.
  const { createUser, setProvider, completeSetup } = await import('../users/service');
  const { encrypt } = await import('../users/crypto');
  const holder = await createUser('test-digest-holder-chat');
  await setProvider(holder.id, 'gemini');
  await completeSetup(holder.id, encrypt('fake-key-for-tests'), true);
  await addHolding(holder.id, {
    symbol: 'AAPL',
    name: 'Apple Inc.',
    quantity: 5,
    asset_class: 'stocks_us',
    currency: 'USD',
    market: 'NASDAQ',
  });

  const data = await collectDigestData(holder.id);

  assert.ok(
    typeof data.portfolio === 'object' && 'error' in data.portfolio,
    'portfolio section should have degraded to an error',
  );
  assert.ok('total' in (data.spending as object), 'spending should be unaffected');
  assert.ok(Array.isArray(data.budgetStatuses), 'budgets should be unaffected');
});

test('formatDigestMessage renders a failed section as unavailable with its reason', async () => {
  const { formatDigestMessage } = await import('./formatter');

  const data = {
    spending: { error: 'db locked' },
    recurringFired: [],
    budgetStatuses: [],
    portfolio: { error: 'price fetch failed' },
  };

  const message = formatDigestMessage(data as any, 'All good.');
  assert.match(message, /Spending: unavailable \(db locked\)/);
});

test('generateSummaryLine falls back to "Watch {category} spending." when a budget is at or above 80%', async () => {
  const { generateSummaryLine } = await import('./summary');

  const data = {
    spending: emptySpending(),
    recurringFired: [],
    budgetStatuses: [
      {
        category: 'Food',
        budget_amount: 10000,
        budget_currency: 'SGD',
        budget_sgd: 10000,
        spent_sgd: 9000,
        percentage: 90,
        remaining_sgd: 1000,
        days_left_in_month: 2,
      },
    ],
    portfolio: { error: 'price fetch failed' },
  };

  const line = await generateSummaryLine(userId, data as any);
  assert.equal(line, 'Watch Food spending.');
});

test('generateSummaryLine falls back to "All good." when no budget is over threshold', async () => {
  const { generateSummaryLine } = await import('./summary');

  const data = {
    spending: emptySpending(),
    recurringFired: [],
    budgetStatuses: [],
    portfolio: { error: 'price fetch failed' },
  };

  const line = await generateSummaryLine(userId, data as any);
  assert.equal(line, 'All good.');
});

test('triggerDigestNow does not throw when no bot is available', async () => {
  const { triggerDigestNow } = await import('./index');
  await assert.doesNotReject(() => triggerDigestNow(null));
});

test('triggerDigestNow sends each approved user their own digest on their own chat', async () => {
  const { triggerDigestNow } = await import('./index');
  const sent: Array<{ chatId: string; text: string }> = [];
  const fakeBot = {
    api: {
      sendMessage: async (chatId: string, text: string) => {
        sent.push({ chatId, text });
      },
    },
  } as any;

  await triggerDigestNow(fakeBot);

  // Assert on this user's own delivery rather than a total count — other
  // tests in this file add approved users, and each of them is also due a
  // digest of their own.
  const mine = sent.filter((message) => message.chatId === digestChatId);
  assert.equal(mine.length, 1);
  assert.match(mine[0].text, /Daily Digest/);
});

test('triggerDigestNow skips users who are not approved', async () => {
  const { triggerDigestNow } = await import('./index');
  const { createUser, setProvider, completeSetup } = await import('../users/service');
  const { encrypt } = await import('../users/crypto');

  // Finishes setup but stays pending_approval — must not receive a digest.
  const pending = await createUser('test-digest-pending-chat');
  await setProvider(pending.id, 'gemini');
  await completeSetup(pending.id, encrypt('fake-key-for-tests'), false);

  const sent: Array<{ chatId: string; text: string }> = [];
  const fakeBot = {
    api: {
      sendMessage: async (chatId: string, text: string) => {
        sent.push({ chatId, text });
      },
    },
  } as any;

  await triggerDigestNow(fakeBot);

  assert.ok(!sent.some((message) => message.chatId === 'test-digest-pending-chat'));
});

test('triggerDigestNow keeps going when one user fails', async () => {
  const { triggerDigestNow } = await import('./index');
  const { createUser, setProvider, completeSetup } = await import('../users/service');
  const { encrypt } = await import('../users/crypto');

  const second = await createUser('test-digest-second-chat');
  await setProvider(second.id, 'gemini');
  await completeSetup(second.id, encrypt('fake-key-for-tests'), true);

  const sent: Array<{ chatId: string; text: string }> = [];
  const fakeBot = {
    api: {
      sendMessage: async (chatId: string, text: string) => {
        if (chatId === digestChatId) {
          throw new Error('simulated Telegram failure for the first user');
        }
        sent.push({ chatId, text });
      },
    },
  } as any;

  await assert.doesNotReject(() => triggerDigestNow(fakeBot));
  assert.ok(sent.some((message) => message.chatId === 'test-digest-second-chat'));
});

test('buildDigestMessage returns a string containing the digest header', async () => {
  const { buildDigestMessage } = await import('./index');
  const message = await buildDigestMessage(userId);
  assert.match(message, /^Daily Digest - /);
});
