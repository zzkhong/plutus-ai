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

test('buildAssistantReply uses the user message details for expense replies', async () => {
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
  assert.match(reply, /Food/i);
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