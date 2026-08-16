import test from 'node:test';
import assert from 'node:assert/strict';

import { buildAssistantReply } from './ai';

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
