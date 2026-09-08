import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

process.env.DATABASE_URL = './data/test-ai-budget.db';

const aiTestDbPath = path.resolve('./data/test-ai-budget.db');
if (fs.existsSync(aiTestDbPath)) {
  fs.rmSync(aiTestDbPath, { force: true });
}

before(async () => {
  const { runMigrations } = await import('../db/migrate');
  runMigrations();
});

test('buildAssistantReply logs a real expense transaction for the expense intent', async () => {
  const { stubGeminiCategorization } = await import('../testing/geminiStub');
  const restoreGemini = stubGeminiCategorization();

  try {
    const { buildAssistantReply } = await import('./ai');
    const reply = await buildAssistantReply({
      intent: 'expense',
      confidence: 0.96,
      extracted: {
        amount: 4.5,
        merchant: 'Ya Kun',
        category: 'Food',
      },
      rawText: 'Spent $4.50 at Ya Kun',
    });

    assert.match(reply, /4\.50/i);
    assert.match(reply, /Ya Kun/i);

    const { getTopExpenses } = await import('../expense/service');
    const [logged] = await getTopExpenses('today', 1);
    assert.ok(logged);
    assert.equal(logged.merchant, 'Ya Kun');
    assert.equal(logged.amount, 450);
    assert.equal(logged.source, 'text');
  } finally {
    restoreGemini();
  }
});

test('buildAssistantReply asks for an amount when the expense intent has none', async () => {
  const { buildAssistantReply } = await import('./ai');
  const reply = await buildAssistantReply({
    intent: 'expense',
    confidence: 0.4,
    extracted: { merchant: 'Ya Kun' },
    rawText: 'bought something at Ya Kun',
  });

  assert.match(reply, /how much/i);
});

test('buildAssistantReply returns the generic error message when Gemini failed, not a guessed intent', async () => {
  const { buildAssistantReply } = await import('./ai');
  const reply = await buildAssistantReply({
    intent: 'unknown',
    confidence: 0,
    extracted: {},
    rawText: 'Spent $4.50 at Ya Kun',
    serviceError: true,
  });

  assert.match(reply, /hiccupped/i);
});

test(
  'classifyUserMessage returns expense intent for a real Gemini call',
  { skip: !process.env.RUN_LIVE_AI_TESTS && 'set RUN_LIVE_AI_TESTS=1 to run this against the real Gemini API' },
  async () => {
    // Pluto AI is Gemini-first with no rule-based fallback (see doc/tasks/02-telegram-bot.md),
    // so this exercises the real API using GOOGLE_API_KEY from the environment.
    // Opt-in only (RUN_LIVE_AI_TESTS=1): costs real API credits and needs network access.
    const { classifyUserMessage } = await import('./ai');
    const result = await classifyUserMessage('Spent $4.50 at Ya Kun');
    assert.equal(result.intent, 'expense');
    assert.equal(result.serviceError, undefined);
  },
);

test('classifyUserMessage degrades gracefully instead of guessing when the Gemini call fails', async () => {
  const originalFetch = global.fetch;
  global.fetch = (() => {
    throw new Error('simulated network failure');
  }) as typeof fetch;

  try {
    const { classifyUserMessage } = await import('./ai');
    const result = await classifyUserMessage('Spent $4.50 at Ya Kun');
    assert.equal(result.intent, 'unknown');
    assert.equal(result.serviceError, true);
  } finally {
    global.fetch = originalFetch;
  }
});

test('buildAssistantReply sets a real budget for the budget intent', async () => {
  const { buildAssistantReply } = await import('./ai');
  const reply = await buildAssistantReply({
    intent: 'budget',
    confidence: 0.9,
    extracted: { category: 'Food', budgetAmount: 800 },
    rawText: 'Set food budget to $800/month',
  });

  assert.match(reply, /Food/);
  assert.match(reply, /800\.00/);

  const { findBudgetByCategory } = await import('../budget/service');
  const budget = await findBudgetByCategory('Food');
  assert.ok(budget);
  assert.equal(budget!.amount_sgd, 80000);
});

test('buildAssistantReply removes a budget when the action indicates removal', async () => {
  const { buildAssistantReply } = await import('./ai');
  const { setBudget, findBudgetByCategory } = await import('../budget/service');
  await setBudget('Travel', 200, 'SGD');

  const reply = await buildAssistantReply({
    intent: 'budget',
    confidence: 0.9,
    extracted: { category: 'Travel', action: 'remove' },
    rawText: 'Remove my travel budget',
  });

  assert.match(reply, /removed/i);
  assert.match(reply, /Travel/);

  const budget = await findBudgetByCategory('Travel');
  assert.equal(budget, null);
});

test('buildAssistantReply asks for a category when the budget intent has none', async () => {
  const { buildAssistantReply } = await import('./ai');
  const reply = await buildAssistantReply({
    intent: 'budget',
    confidence: 0.5,
    extracted: {},
    rawText: 'set a budget',
  });

  assert.match(reply, /which category/i);
});

test('buildAssistantReply records a new crypto holding for the holdings intent', async () => {
  const { buildAssistantReply } = await import('./ai');
  const reply = await buildAssistantReply({
    intent: 'holdings',
    confidence: 0.9,
    extracted: { symbol: 'BTC', amount: 0.5, assetClass: 'crypto', currency: 'USD' },
    rawText: 'I hold 0.5 BTC',
  });

  assert.match(reply, /BTC/);

  const { listHoldings } = await import('../portfolio/service');
  const allHoldings = await listHoldings();
  const btc = allHoldings.find((h) => h.symbol === 'BTC');

  assert.ok(btc);
  assert.equal(btc!.quantity, 0.5);
  assert.equal(btc!.broker, null);
});

test('buildAssistantReply removes a holding when the action indicates removal', async () => {
  const { buildAssistantReply } = await import('./ai');
  const { addHolding, listHoldings } = await import('../portfolio/service');
  await addHolding({ symbol: 'ETH', name: 'ETH', quantity: 1, asset_class: 'crypto', currency: 'USD', market: 'Crypto' });

  const reply = await buildAssistantReply({
    intent: 'holdings',
    confidence: 0.9,
    extracted: { symbol: 'ETH', action: 'remove' },
    rawText: 'Remove my ETH holding',
  });

  assert.match(reply, /removed/i);

  const allHoldings = await listHoldings();
  assert.ok(!allHoldings.some((h) => h.symbol === 'ETH'));
});

test('buildAssistantReply falls back to crypto when the holdings intent has an unrecognized asset class', async () => {
  const { buildAssistantReply } = await import('./ai');
  const reply = await buildAssistantReply({
    intent: 'holdings',
    confidence: 0.9,
    extracted: { symbol: 'AAPL', amount: 10, assetClass: 'stocks_us', currency: 'USD' },
    rawText: 'I hold 10 AAPL',
  });

  assert.match(reply, /AAPL/);

  const { listHoldings } = await import('../portfolio/service');
  const allHoldings = await listHoldings();
  const aapl = allHoldings.find((h) => h.symbol === 'AAPL');

  assert.ok(aapl);
  assert.equal(aapl!.asset_class, 'crypto');
});

test('buildAssistantReply falls back to USD when the holdings intent has an unrecognized currency', async () => {
  const { buildAssistantReply } = await import('./ai');
  const reply = await buildAssistantReply({
    intent: 'holdings',
    confidence: 0.9,
    extracted: { symbol: 'DOGE', amount: 100, assetClass: 'crypto', currency: 'HKD' },
    rawText: 'I hold 100 DOGE',
  });

  assert.match(reply, /DOGE/);

  const { listHoldings } = await import('../portfolio/service');
  const allHoldings = await listHoldings();
  const doge = allHoldings.find((h) => h.symbol === 'DOGE');

  assert.ok(doge);
  assert.equal(doge!.currency, 'USD');
});

test('buildAssistantReply asks which holding when the holdings intent has no symbol', async () => {
  const { buildAssistantReply } = await import('./ai');
  const reply = await buildAssistantReply({
    intent: 'holdings',
    confidence: 0.5,
    extracted: {},
    rawText: 'I have some crypto',
  });

  assert.match(reply, /which holding/i);
});

test('buildAssistantReply answers a query intent with real spending data', async () => {
  const { stubGeminiCategorization } = await import('../testing/geminiStub');
  const restoreGemini = stubGeminiCategorization();

  try {
    const { getSpendingSummary, logExpense } = await import('../expense/service');
    const before = await getSpendingSummary('today');

    await logExpense({ amount: 10, merchant: 'Fairprice', source: 'text' });

    const { buildAssistantReply } = await import('./ai');
    const reply = await buildAssistantReply({
      intent: 'query',
      confidence: 0.8,
      extracted: { period: 'today' },
      rawText: 'How much did I spend today?',
    });

    const after = await getSpendingSummary('today');
    assert.equal(after.count, before.count + 1);
    assert.match(reply, new RegExp(`${(after.total / 100).toFixed(2)}`));
    assert.match(reply, new RegExp(String(after.count)));
  } finally {
    restoreGemini();
  }
});

test('buildAssistantReply falls back to a month query when period is not recognized', async () => {
  const { getSpendingSummary } = await import('../expense/service');
  const { buildAssistantReply } = await import('./ai');
  const monthSummary = await getSpendingSummary('month');

  const reply = await buildAssistantReply({
    intent: 'query',
    confidence: 0.5,
    extracted: { period: 'this year' },
    rawText: 'how much have I spent',
  });

  assert.match(reply, new RegExp(`${(monthSummary.total / 100).toFixed(2)}`));
});

test('buildAssistantReply creates a real recurring transaction for the recurring intent', async () => {
  const { stubGeminiCategorization } = await import('../testing/geminiStub');
  const restoreGemini = stubGeminiCategorization();

  try {
    const { buildAssistantReply } = await import('./ai');
    const reply = await buildAssistantReply({
      intent: 'recurring',
      confidence: 0.9,
      extracted: { amount: 15.98, merchant: 'Netflix', dayOfMonth: 5 },
      rawText: 'Netflix $15.98 every 5th',
    });

    assert.match(reply, /Netflix/i);
    assert.match(reply, /5/);

    const { listRecurring } = await import('../expense/service');
    const all = await listRecurring();
    const netflix = all.find((r) => r.merchant === 'Netflix');

    assert.ok(netflix);
    assert.equal(netflix.amount, 1598);
    assert.equal(netflix.day_of_month, 5);
  } finally {
    restoreGemini();
  }
});

test('buildAssistantReply asks for a day of month when the recurring intent has none', async () => {
  const { buildAssistantReply } = await import('./ai');
  const reply = await buildAssistantReply({
    intent: 'recurring',
    confidence: 0.6,
    extracted: { amount: 15.98, merchant: 'Netflix' },
    rawText: 'Netflix $15.98 monthly',
  });

  assert.match(reply, /which day|day of the month/i);
});

test('buildAssistantReply asks which merchant when the recurring intent has none', async () => {
  const { buildAssistantReply } = await import('./ai');
  const reply = await buildAssistantReply({
    intent: 'recurring',
    confidence: 0.5,
    extracted: {},
    rawText: 'set up a recurring payment',
  });

  assert.match(reply, /which (merchant|subscription|recurring)/i);
});

test('buildAssistantReply removes a recurring transaction matched by merchant', async () => {
  const { stubGeminiCategorization } = await import('../testing/geminiStub');
  const restoreGemini = stubGeminiCategorization();

  try {
    const { createRecurring, listRecurring } = await import('../expense/service');
    await createRecurring({ amount: 9.9, merchant: 'Spotify', day_of_month: 1 });

    const { buildAssistantReply } = await import('./ai');
    const reply = await buildAssistantReply({
      intent: 'recurring',
      confidence: 0.9,
      extracted: { merchant: 'Spotify', action: 'remove' },
      rawText: 'Cancel my Spotify subscription',
    });

    assert.match(reply, /removed/i);
    assert.match(reply, /Spotify/i);

    const all = await listRecurring();
    assert.ok(!all.some((r) => r.merchant === 'Spotify'));
  } finally {
    restoreGemini();
  }
});

test('buildAssistantReply tells the user when no matching recurring entry is found to remove', async () => {
  const { buildAssistantReply } = await import('./ai');
  const reply = await buildAssistantReply({
    intent: 'recurring',
    confidence: 0.7,
    extracted: { merchant: 'NonexistentThing', action: 'remove' },
    rawText: 'cancel NonexistentThing',
  });

  assert.match(reply, /couldn.?t find/i);
});