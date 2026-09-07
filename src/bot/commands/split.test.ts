import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

process.env.DATABASE_URL = './data/test-split-command.db';

const testDbPath = path.resolve('./data/test-split-command.db');
if (fs.existsSync(testDbPath)) {
  fs.rmSync(testDbPath, { force: true });
}

before(async () => {
  const { runMigrations } = await import('../../db/migrate');
  runMigrations();
});

/**
 * Queues canned Gemini text responses in call order, regardless of which
 * Gemini call site makes the request — simpler than content-sniffing since
 * this orchestration layer's tests care about sequencing, not prompt
 * content (extraction.ts/assignment.ts/categorizer.ts already have their
 * own dedicated prompt-parsing tests).
 */
function stubGeminiSequence(responses: string[]): () => void {
  const originalFetch = global.fetch;
  let callIndex = 0;

  global.fetch = (async () => {
    const text = responses[Math.min(callIndex, responses.length - 1)];
    callIndex += 1;
    const body = JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  return () => {
    global.fetch = originalFetch;
  };
}

const EVEN_SPLIT_RESPONSE = JSON.stringify({
  mode: 'even',
  headcount: 2,
  itemAssignments: null,
  requesterLabel: 'me',
});

const CATEGORY_RESPONSE = JSON.stringify({ category: 'Food', confidence: 0.9 });

test('handleSplitCommand starts a split and asks for a photo', async () => {
  const { handleSplitCommand } = await import('./split');
  const { getSplitState } = await import('../../split/state');

  const reply = handleSplitCommand(3001);

  assert.match(reply, /photo/i);
  assert.equal(getSplitState(3001)?.stage, 'awaiting_photo');
});

test('handleCancelCommand clears an active split and reports nothing to cancel otherwise', async () => {
  const { handleSplitCommand, handleCancelCommand } = await import('./split');
  const { getSplitState } = await import('../../split/state');

  handleSplitCommand(3002);
  assert.match(handleCancelCommand(3002), /cancelled/i);
  assert.equal(getSplitState(3002), undefined);

  assert.match(handleCancelCommand(3002), /nothing to cancel/i);
});

test('handleSplitPhoto without an active split hints at /split instead of calling Gemini', async () => {
  const { handleSplitPhoto } = await import('./split');
  const originalFetch = global.fetch;
  let fetchCalled = false;
  global.fetch = (async () => {
    fetchCalled = true;
    throw new Error('should not be called');
  }) as typeof fetch;

  try {
    const reply = await handleSplitPhoto(3003, Buffer.from('fake jpeg'), 'image/jpeg');
    assert.match(reply, /split/i);
    assert.equal(fetchCalled, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('handleSplitPhoto extracts a receipt and moves to awaiting_instructions', async () => {
  const { handleSplitCommand, handleSplitPhoto } = await import('./split');
  const { getSplitState } = await import('../../split/state');

  handleSplitCommand(3004);
  const receiptResponse = JSON.stringify({
    merchant: 'Ya Kun',
    items: [
      { name: 'Kaya Toast', price: 5 },
      { name: 'Iced Milo', price: 5 },
    ],
    taxAndTip: 0,
    total: 10,
    currency: 'SGD',
  });
  const restore = stubGeminiSequence([receiptResponse]);

  try {
    const reply = await handleSplitPhoto(3004, Buffer.from('fake jpeg'), 'image/jpeg');
    assert.match(reply, /Ya Kun/);
    assert.equal(getSplitState(3004)?.stage, 'awaiting_instructions');
  } finally {
    restore();
  }
});

test('handleSplitPhoto keeps the flow at awaiting_photo and replies with an error when extraction fails', async () => {
  const { handleSplitCommand, handleSplitPhoto } = await import('./split');
  const { getSplitState } = await import('../../split/state');

  handleSplitCommand(3005);
  const restore = stubGeminiSequence(['not valid json']);

  try {
    const reply = await handleSplitPhoto(3005, Buffer.from('fake jpeg'), 'image/jpeg');
    assert.match(reply, /couldn't read/i);
    assert.equal(getSplitState(3005)?.stage, 'awaiting_photo');
  } finally {
    restore();
  }
});

test('handleSplitTextMessage while awaiting_photo replies helpfully and leaves the stage unchanged', async () => {
  const { handleSplitCommand, handleSplitTextMessage } = await import('./split');
  const { getSplitState } = await import('../../split/state');

  handleSplitCommand(3009);
  const reply = await handleSplitTextMessage(3009, 'ok');

  assert.match(reply, /photo/i);
  assert.equal(getSplitState(3009)?.stage, 'awaiting_photo');
});

test('handleSplitTextMessage: even split then Yes logs only the requester share', async () => {
  const { handleSplitCommand, handleSplitPhoto, handleSplitTextMessage } = await import('./split');
  const { getSplitState } = await import('../../split/state');
  const { getSpendingSummary } = await import('../../expense');

  handleSplitCommand(3006);
  const receiptResponse = JSON.stringify({
    merchant: 'Test Cafe',
    items: [{ name: 'Meal', price: 20 }],
    taxAndTip: 0,
    total: 20,
    currency: 'SGD',
  });

  let restore = stubGeminiSequence([receiptResponse]);
  await handleSplitPhoto(3006, Buffer.from('fake jpeg'), 'image/jpeg');
  restore();

  restore = stubGeminiSequence([EVEN_SPLIT_RESPONSE]);
  const breakdownReply = await handleSplitTextMessage(3006, 'split between 2');
  restore();

  assert.match(breakdownReply, /You: S\$10\.00/);
  assert.match(breakdownReply, /Log your share/i);
  assert.equal(getSplitState(3006)?.stage, 'awaiting_log_confirmation');

  const before = await getSpendingSummary('today');

  restore = stubGeminiSequence([CATEGORY_RESPONSE]);
  const logReply = await handleSplitTextMessage(3006, 'yes');
  restore();

  assert.match(logReply, /Logged S\$10\.00/);
  assert.equal(getSplitState(3006), undefined);

  const after = await getSpendingSummary('today');
  assert.equal(after.total - before.total, 1000); // 10.00 SGD in cents, only the requester's share
  assert.equal(after.count - before.count, 1);
});

test('handleSplitTextMessage: No logs nothing and clears state', async () => {
  const { handleSplitCommand, handleSplitPhoto, handleSplitTextMessage } = await import('./split');
  const { getSplitState } = await import('../../split/state');
  const { getSpendingSummary } = await import('../../expense');

  handleSplitCommand(3007);
  const receiptResponse = JSON.stringify({
    merchant: 'Test Cafe',
    items: [{ name: 'Meal', price: 20 }],
    taxAndTip: 0,
    total: 20,
    currency: 'SGD',
  });

  let restore = stubGeminiSequence([receiptResponse]);
  await handleSplitPhoto(3007, Buffer.from('fake jpeg'), 'image/jpeg');
  restore();

  restore = stubGeminiSequence([EVEN_SPLIT_RESPONSE]);
  await handleSplitTextMessage(3007, 'split between 2');
  restore();

  const before = await getSpendingSummary('today');
  const reply = await handleSplitTextMessage(3007, 'no');
  const after = await getSpendingSummary('today');

  assert.match(reply, /nothing logged/i);
  assert.equal(getSplitState(3007), undefined);
  assert.equal(after.total, before.total);
  assert.equal(after.count, before.count);
});

test('handleSplitTextMessage asks for clarification when the requester share is ambiguous, without advancing the stage', async () => {
  // Note: this only applies to itemized mode. calculateEvenSplit always
  // treats the first share ("You") as the requester by construction, so an
  // even split can never produce a null requesterShare — see calculator.ts.
  const { handleSplitCommand, handleSplitPhoto, handleSplitTextMessage } = await import('./split');
  const { getSplitState } = await import('../../split/state');

  handleSplitCommand(3008);
  const receiptResponse = JSON.stringify({
    merchant: 'Test Cafe',
    items: [{ name: 'Meal', price: 20 }],
    taxAndTip: 0,
    total: 20,
    currency: 'SGD',
  });

  let restore = stubGeminiSequence([receiptResponse]);
  await handleSplitPhoto(3008, Buffer.from('fake jpeg'), 'image/jpeg');
  restore();

  // Itemized, but requesterLabel is null (Gemini couldn't tell who "you" is)
  // and the only assigned label is "Alice" — calculateItemizedSplit has no
  // share to match a null/absent requesterLabel against, so requesterShare
  // comes back null.
  const ambiguousResponse = JSON.stringify({
    mode: 'itemized',
    itemAssignments: [{ itemName: 'Meal', personLabels: ['Alice'] }],
    requesterLabel: null,
  });
  restore = stubGeminiSequence([ambiguousResponse]);

  try {
    const reply = await handleSplitTextMessage(3008, 'Alice had the meal');
    assert.match(reply, /which share is yours/i);
    assert.equal(getSplitState(3008)?.stage, 'awaiting_instructions');
  } finally {
    restore();
  }
});
