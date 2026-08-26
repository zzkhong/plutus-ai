import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { buildAssistantReply, classifyUserMessage } from './ai';

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
    const result = await classifyUserMessage('Spent $4.50 at Ya Kun');
    assert.equal(result.intent, 'unknown');
    assert.equal(result.serviceError, true);
  } finally {
    global.fetch = originalFetch;
  }
});

test('buildAssistantReply sets a real budget for the budget intent', async () => {
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
  const reply = await buildAssistantReply({
    intent: 'budget',
    confidence: 0.5,
    extracted: {},
    rawText: 'set a budget',
  });

  assert.match(reply, /which category/i);
});