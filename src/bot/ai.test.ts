import test from 'node:test';
import assert from 'node:assert/strict';

import { buildAssistantReply, classifyUserMessage } from './ai';

test('buildAssistantReply uses the user message details for expense replies', () => {
  const reply = buildAssistantReply({
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


test('classifyUserMessage returns expense intent', async (t) => {
  // Mock the Gemini API
  const originalEnv = process.env.GOOGLE_API_KEY;
  process.env.GOOGLE_API_KEY = '';  // Disable Gemini, use fallback heuristics
  
  const result = await classifyUserMessage('Spent $4.50 at Ya Kun');
  assert.equal(result.intent, 'expense');
  
  process.env.GOOGLE_API_KEY = originalEnv;
});