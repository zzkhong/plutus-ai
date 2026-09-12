import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

process.env.DATABASE_URL = './data/test-document-handler.db';

const testDbPath = path.resolve('./data/test-document-handler.db');
if (fs.existsSync(testDbPath)) {
  fs.rmSync(testDbPath, { force: true });
}

let userId: string;

before(async () => {
  const { runMigrations } = await import('../../db/migrate');
  await runMigrations();
  const { createUser, setProvider, completeSetup } = await import('../../users/service');
  const { encrypt } = await import('../../users/crypto');
  const user = await createUser('test-document-handler-chat');
  await setProvider(user.id, 'gemini');
  await completeSetup(user.id, encrypt('fake-key-for-tests'), true);
  userId = user.id;
});

function stubStatementReader(statement: Record<string, unknown>) {
  const originalFetch = global.fetch;
  global.fetch = (async () =>
    new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(statement) }] } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
  return () => {
    global.fetch = originalFetch;
  };
}

test('statementFileKind accepts PDFs, screenshots and CSV/text exports, and nothing else', async () => {
  const { statementFileKind } = await import('./document');

  assert.equal(statementFileKind('application/pdf'), 'pdf');
  assert.equal(statementFileKind('application/octet-stream', 'U6602063_20260910.pdf'), 'pdf');
  assert.equal(statementFileKind('image/png'), 'image');
  assert.equal(statementFileKind('image/jpeg'), 'image');
  assert.equal(statementFileKind('text/csv'), 'text');
  assert.equal(statementFileKind('application/vnd.ms-excel', 'positions.csv'), 'text');
  assert.equal(statementFileKind('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'positions.xlsx'), null);
  assert.equal(statementFileKind('application/zip', 'archive.zip'), null);
});

test('handleDocumentMessage turns away a file type it cannot read, without calling the model', async () => {
  const originalFetch = global.fetch;
  let fetchCalled = false;
  global.fetch = (async () => {
    fetchCalled = true;
    throw new Error('should not be called');
  }) as typeof fetch;

  try {
    const { handleDocumentMessage } = await import('./document');
    const { text: reply } = await handleDocumentMessage(userId, Buffer.from('PK'), 'application/zip', 'archive.zip');

    assert.match(reply, /PDF, a screenshot or a CSV/);
    assert.equal(fetchCalled, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('handleDocumentMessage returns a friendly message when the statement cannot be read', async () => {
  const originalFetch = global.fetch;
  global.fetch = (() => {
    throw new Error('simulated network failure');
  }) as typeof fetch;

  try {
    const { handleDocumentMessage } = await import('./document');
    const { text: reply } = await handleDocumentMessage(userId, Buffer.from('%PDF-1.4 fake'), 'application/pdf');

    assert.match(reply, /couldn't read that statement/i);
  } finally {
    global.fetch = originalFetch;
  }
});

test('handleDocumentMessage imports a statement at its prices, and a newer one from the same broker replaces it', async () => {
  const { handleDocumentMessage } = await import('./document');
  const { listHoldings } = await import('../../portfolio/service');

  let restore = stubStatementReader({
    broker: 'Interactive Brokers',
    statement_date: '2026-09-10',
    holdings: [
      { symbol: 'AAPL', name: 'APPLE INC', quantity: 38.3108, price: 326.57, currency: 'USD', asset_class: 'stocks_us', market: 'NASDAQ' },
      { symbol: 'NVDA', name: 'NVIDIA CORP', quantity: 106.3419, price: 218.36, currency: 'USD', asset_class: 'stocks_us', market: 'NASDAQ' },
      { symbol: '0700', name: 'TENCENT', quantity: 100, price: 400, currency: 'HKD', asset_class: 'other', market: 'SEHK' },
    ],
  });
  let reply: string;
  try {
    reply = (await handleDocumentMessage(userId, Buffer.from('Symbol,Quantity\n'), 'text/csv', 'positions.csv')).text;
  } finally {
    restore();
  }

  assert.match(reply, /Updated your IBKR holdings: 2 positions at the statement's prices from 10 Sep/);
  assert.match(reply, /Skipped 1 I can't value yet: 0700 \(priced in HKD\)/);

  const imported = (await listHoldings(userId)).filter((h) => h.broker === 'ibkr');
  assert.equal(imported.length, 2);
  assert.equal(imported.find((h) => h.symbol === 'AAPL')?.price, 326.57);

  // The next statement from the same broker (named differently by the model) replaces the first.
  restore = stubStatementReader({
    broker: 'ibkr',
    statement_date: '2026-09-11',
    holdings: [{ symbol: 'AAPL', name: 'APPLE INC', quantity: 40, price: 330, currency: 'USD', asset_class: 'stocks_us', market: 'NASDAQ' }],
  });
  try {
    await handleDocumentMessage(userId, Buffer.from('%PDF-1.4 fake'), 'application/pdf');
  } finally {
    restore();
  }

  const replaced = (await listHoldings(userId)).filter((h) => h.broker === 'ibkr');
  assert.deepEqual(
    replaced.map((h) => [h.symbol, h.quantity, h.price]),
    [['AAPL', 40, 330]],
  );
});

function stubReplies(replies: unknown[]) {
  const originalFetch = global.fetch;
  let call = 0;
  global.fetch = (async () => {
    const text = JSON.stringify(replies[Math.min(call++, replies.length - 1)]);
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return () => {
    global.fetch = originalFetch;
  };
}

test('a receipt sent as a file, like an e-receipt PDF, is logged as an expense', async () => {
  const { handleDocumentMessage } = await import('./document');
  const restore = stubReplies([
    { broker: null, statement_date: null, holdings: [] },
    { isReceipt: true, merchant: 'Grab', total: 18.4, currency: 'SGD', date: null, category: 'Transport' },
  ]);
  let reply;
  try {
    reply = await handleDocumentMessage(userId, Buffer.from('%PDF-1.4 fake'), 'application/pdf', 'grab-receipt.pdf');
  } finally {
    restore();
  }

  assert.match(reply.text, /^Logged S\$18\.40 at Grab under Transport from your receipt\./);
  assert.ok(reply.keyboard);
});

test('a file that is neither a statement nor a receipt says so and logs nothing', async () => {
  const { handleDocumentMessage } = await import('./document');
  const { listRecentTransactions } = await import('../../expense/service');
  const before = (await listRecentTransactions(userId, 50)).length;
  const restore = stubReplies([{ broker: null, statement_date: null, holdings: [] }, { isReceipt: false }]);
  let reply;
  try {
    reply = await handleDocumentMessage(userId, Buffer.from('fake png'), 'image/png', 'cat.png');
  } finally {
    restore();
  }

  assert.match(reply.text, /doesn't look like a brokerage statement or a receipt/);
  assert.equal(reply.keyboard, undefined);
  assert.equal((await listRecentTransactions(userId, 50)).length, before);
});
