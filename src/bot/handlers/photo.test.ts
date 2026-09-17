import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

process.env.DATABASE_URL = './data/test-photo.db';

const testDbPath = path.resolve('./data/test-photo.db');
if (fs.existsSync(testDbPath)) {
  fs.rmSync(testDbPath, { force: true });
}

let userId: string;

before(async () => {
  const { runMigrations } = await import('../../db/migrate');
  await runMigrations();
  const { createUser, setProvider, completeSetup } = await import('../../users/service');
  const { encrypt } = await import('../../users/crypto');
  const user = await createUser('test-photo-chat');
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

/** Answers model calls with `replies` in order, counting the calls. */
async function withReadings<T>(replies: unknown[], run: () => Promise<T>): Promise<{ result: T; calls: number }> {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = (async () => {
    const reply = replies[Math.min(calls, replies.length - 1)];
    calls += 1;
    return geminiText(JSON.stringify(reply));
  }) as typeof fetch;
  try {
    return { result: await run(), calls };
  } finally {
    global.fetch = originalFetch;
  }
}

const photo = Buffer.from('fake jpeg');

test('the receipt reader tells "not a receipt" apart from a receipt it could not read', async () => {
  const { parseReceiptExpense, NotAReceiptError, ReceiptReadError } = await import('../../expense/receipt');

  assert.throws(() => parseReceiptExpense('{"isReceipt": false}'), NotAReceiptError);
  for (const unreadable of ['{"isReceipt": true, "total": 120, "currency": "THB"}', '{"isReceipt": true, "total": 0, "currency": "SGD"}', 'no json']) {
    assert.throws(
      () => parseReceiptExpense(unreadable),
      (error: unknown) => error instanceof ReceiptReadError && !(error instanceof NotAReceiptError),
    );
  }
});

test('a receipt photo is logged in one call, remembers its photo, and offers Split this', async () => {
  const { handlePhotoMessage } = await import('./photo');
  const { listRecentTransactions } = await import('../../expense/service');

  const { result: reply, calls } = await withReadings(
    [{ isReceipt: true, merchant: 'Tim Ho Wan', total: 48.2, currency: 'SGD', date: null, category: 'Food' }],
    () => handlePhotoMessage(userId, photo, 'image/jpeg', { photoFileId: 'telegram-file-1' }),
  );

  assert.equal(calls, 1, 'a receipt never reaches the statement reader');
  assert.match(reply.text, /^Logged S\$48\.20 at Tim Ho Wan under Food from your receipt\./);
  assert.match(reply.text, /split this/i);
  const [logged] = await listRecentTransactions(userId, 1);
  assert.equal(logged.photo_file_id, 'telegram-file-1');
  const buttons = (reply.keyboard?.inline_keyboard.flat() ?? []) as Array<{ text: string; callback_data?: string }>;
  assert.ok(buttons.some((button) => button.callback_data === `t:p:c:${logged.id}` && button.text === 'Split this'));
});

test('a portfolio screenshot sent as a photo is imported as a statement', async () => {
  const { handlePhotoMessage } = await import('./photo');
  const { listHoldings } = await import('../../portfolio/service');
  const { listRecentTransactions } = await import('../../expense/service');
  const expensesBefore = (await listRecentTransactions(userId, 50)).length;

  const { result: reply, calls } = await withReadings(
    [
      { isReceipt: false },
      {
        broker: 'Moomoo',
        statement_date: '2026-09-10',
        holdings: [{ symbol: 'AAPL', name: 'APPLE INC', quantity: 10, price: 200, currency: 'USD', asset_class: 'stocks_us', market: 'NASDAQ' }],
      },
    ],
    () => handlePhotoMessage(userId, photo, 'image/jpeg', { photoFileId: 'telegram-file-2' }),
  );

  assert.equal(calls, 2);
  assert.match(reply.text, /Updated your MOOMOO holdings: 1 position/);
  assert.equal((await listHoldings(userId)).filter((holding) => holding.symbol === 'AAPL').length, 1);
  assert.equal((await listRecentTransactions(userId, 50)).length, expensesBefore, 'nothing logged as an expense');
});

test('a receipt that is merely hard to read is never tried as a statement', async () => {
  const { handlePhotoMessage } = await import('./photo');
  const { NOT_A_RECEIPT_REPLY } = await import('./receipt');

  const { result: reply, calls } = await withReadings([{ isReceipt: true, total: 120, currency: 'THB' }], () =>
    handlePhotoMessage(userId, photo, 'image/jpeg'),
  );

  assert.equal(calls, 1);
  assert.equal(reply.text, NOT_A_RECEIPT_REPLY);
});

test('a photo that is neither a receipt nor a statement logs and imports nothing', async () => {
  const { handlePhotoMessage, NOT_A_RECEIPT_OR_STATEMENT_REPLY } = await import('./photo');

  const { result: reply, calls } = await withReadings([{ isReceipt: false }, {}], () =>
    handlePhotoMessage(userId, photo, 'image/jpeg'),
  );

  assert.equal(calls, 2);
  assert.equal(reply.text, NOT_A_RECEIPT_OR_STATEMENT_REPLY);
  assert.equal(reply.keyboard, undefined);
});
