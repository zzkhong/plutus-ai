import test from 'node:test';
import assert from 'node:assert/strict';

import { buildAssistantReply, classifyUserMessage } from './ai';

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

test('classifyUserMessage returns expense intent for a real Gemini call', async () => {
  // Pluto AI is Gemini-first with no rule-based fallback (see doc/tasks/02-telegram-bot.md),
  // so this exercises the real API using GOOGLE_API_KEY from the environment.
  const result = await classifyUserMessage('Spent $4.50 at Ya Kun');
  assert.equal(result.intent, 'expense');
  assert.equal(result.serviceError, undefined);
});

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