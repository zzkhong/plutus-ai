import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { toIsoDate } from '../../utils/dates';

process.env.DATABASE_URL = './data/test-receipt.db';

const testDbPath = path.resolve('./data/test-receipt.db');
if (fs.existsSync(testDbPath)) {
  fs.rmSync(testDbPath, { force: true });
}

let userId: string;

before(async () => {
  const { runMigrations } = await import('../../db/migrate');
  await runMigrations();
  const { createUser, setProvider, completeSetup } = await import('../../users/service');
  const { encrypt } = await import('../../users/crypto');
  const user = await createUser('test-receipt-chat');
  await setProvider(user.id, 'gemini');
  await completeSetup(user.id, encrypt('fake-key-for-stubbed-tests'), true);
  userId = user.id;
});

function geminiText(text: string): Response {
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** Answers every model call with `reply` as the receipt reading, counting the calls. */
async function withReceiptReading<T>(reply: unknown, run: () => Promise<T>): Promise<{ result: T; calls: number }> {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = (async () => {
    calls += 1;
    return geminiText(JSON.stringify(reply));
  }) as typeof fetch;
  try {
    const result = await run();
    return { result, calls };
  } finally {
    global.fetch = originalFetch;
  }
}

const photo = Buffer.from('fake jpeg');

// --- reading --------------------------------------------------------------------

test('parseReceiptExpense reads the total, currency, date and category', async () => {
  const { parseReceiptExpense } = await import('../../expense/receipt');

  const receipt = parseReceiptExpense(
    '```json\n{"isReceipt": true, "merchant": " Din Tai Fung ", "total": 48.3, "currency": "sgd", "date": "2026-06-18", "category": "food"}\n```',
  );

  assert.deepEqual(receipt, {
    merchant: 'Din Tai Fung',
    total: 48.3,
    currency: 'SGD',
    date: '2026-06-18',
    category: 'Food',
  });
});

test('parseReceiptExpense refuses a non-receipt, an unreadable total, or a currency it cannot convert', async () => {
  const { parseReceiptExpense, ReceiptReadError } = await import('../../expense/receipt');

  assert.throws(() => parseReceiptExpense('{"isReceipt": false}'), ReceiptReadError);
  assert.throws(() => parseReceiptExpense('{"isReceipt": true, "total": 0, "currency": "SGD"}'), ReceiptReadError);
  assert.throws(() => parseReceiptExpense('{"isReceipt": true, "total": 120, "currency": "THB"}'), ReceiptReadError);
  assert.throws(() => parseReceiptExpense('no json here'), ReceiptReadError);
});

// --- logging --------------------------------------------------------------------

test('a receipt photo is logged as one expense on its date, categorized by the same call', async () => {
  const { handleReceiptPhoto } = await import('./receipt');
  const { listRecentTransactions } = await import('../../expense/service');
  const now = new Date(2026, 5, 20, 15);

  const { result: reply, calls } = await withReceiptReading(
    { isReceipt: true, merchant: 'Din Tai Fung', total: 48.3, currency: 'SGD', date: '2026-06-18', category: 'Food' },
    () => handleReceiptPhoto(userId, photo, 'image/jpeg', undefined, now),
  );

  assert.equal(calls, 1, 'the receipt reading supplies the category — no separate categorization call');
  assert.match(reply.text, /^Logged S\$48\.30 at Din Tai Fung under Food, on 18 Jun 2026 from your receipt\./);
  const [logged] = await listRecentTransactions(userId, 1);
  assert.equal(logged.source, 'receipt');
  assert.equal(toIsoDate(logged.spent_at), '2026-06-18');
  assert.ok(
    (reply.keyboard?.inline_keyboard.flat() as any[]).some((button) => button.callback_data === `t:d:c:${logged.id}`),
    'comes with an Undo button',
  );
});

test('a receipt date too far back is taken as a misread and the expense logged today', async () => {
  const { handleReceiptPhoto } = await import('./receipt');
  const { listRecentTransactions } = await import('../../expense/service');

  await withReceiptReading(
    { isReceipt: true, merchant: 'Old Print', total: 12, currency: 'SGD', date: '2016-06-18', category: 'Shopping' },
    () => handleReceiptPhoto(userId, photo, 'image/jpeg'),
  );

  const [logged] = await listRecentTransactions(userId, 1);
  assert.equal(logged.merchant, 'Old Print');
  assert.equal(toIsoDate(logged.spent_at), toIsoDate(new Date()));
});

test('a receipt in ringgit is converted, and the caption kept as the note', async () => {
  const { handleReceiptPhoto } = await import('./receipt');
  const { listRecentTransactions } = await import('../../expense/service');

  const { result: reply } = await withReceiptReading(
    { isReceipt: true, merchant: 'Kopitiam JB', total: 45, currency: 'MYR', date: null, category: 'Food' },
    () => handleReceiptPhoto(userId, photo, 'image/jpeg', ' team lunch '),
  );

  assert.match(reply.text, /RM45\.00 \(S\$14\.02\)/);
  const [logged] = await listRecentTransactions(userId, 1);
  assert.equal(logged.note, 'team lunch');
});

test('a photo that is not a receipt logs nothing and says how to use photos', async () => {
  const { handleReceiptPhoto, NOT_A_RECEIPT_REPLY } = await import('./receipt');
  const { listRecentTransactions } = await import('../../expense/service');
  const before = (await listRecentTransactions(userId, 50)).length;

  const { result: reply } = await withReceiptReading({ isReceipt: false }, () =>
    handleReceiptPhoto(userId, photo, 'image/jpeg'),
  );

  assert.equal(reply.text, NOT_A_RECEIPT_REPLY);
  assert.equal(reply.keyboard, undefined);
  assert.equal((await listRecentTransactions(userId, 50)).length, before);
});
