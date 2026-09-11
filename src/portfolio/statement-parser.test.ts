import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// DATABASE_URL must be set before anything pulls in src/config or src/db.
// TypeScript hoists every `require` above this line, so ./statement-parser
// (which reaches src/db through users/service) is loaded dynamically in the
// before hook instead of imported statically — a static import here would
// open and migrate the real ./data/pluto.db.
process.env.DATABASE_URL = './data/test-statement-parser.db';

const testDbPath = path.resolve('./data/test-statement-parser.db');
if (fs.existsSync(testDbPath)) {
  fs.rmSync(testDbPath, { force: true });
}

type StatementParserModule = typeof import('./statement-parser');

let parseGeminiStatementResponse: StatementParserModule['parseGeminiStatementResponse'];
let StatementParseError: StatementParserModule['StatementParseError'];

// parseStatement resolves the caller's own provider/key off their users row,
// so even the failure-path test needs a real approved user to resolve.
let userId: string;

before(async () => {
  const { runMigrations } = await import('../db/migrate');
  runMigrations();
  const { createUser, setProvider, completeSetup } = await import('../users/service');
  const { encrypt } = await import('../users/crypto');
  const user = await createUser('test-statement-parser-chat');
  await setProvider(user.id, 'gemini');
  await completeSetup(user.id, encrypt('fake-key-for-tests'), true);
  userId = user.id;

  const statementParser = await import('./statement-parser');
  parseGeminiStatementResponse = statementParser.parseGeminiStatementResponse;
  StatementParseError = statementParser.StatementParseError;
});

test('parseGeminiStatementResponse maps a valid IBKR JSON response', () => {
  const raw = `Here you go:\n{"broker": "ibkr", "holdings": [{"symbol": "AAPL", "name": "Apple Inc.", "quantity": 10, "asset_class": "stocks_us", "currency": "USD", "market": "NASDAQ"}]}`;

  const result = parseGeminiStatementResponse(raw);

  assert.equal(result.broker, 'ibkr');
  assert.equal(result.holdings.length, 1);
  assert.equal(result.holdings[0].symbol, 'AAPL');
});

test('parseGeminiStatementResponse maps a valid Moomoo JSON response', () => {
  const raw = `{"broker": "moomoo", "holdings": [{"symbol": "SIA", "name": "Singapore Airlines", "quantity": 100, "asset_class": "stocks_sg", "currency": "SGD", "market": "SGX"}]}`;

  const result = parseGeminiStatementResponse(raw);

  assert.equal(result.broker, 'moomoo');
  assert.equal(result.holdings[0].asset_class, 'stocks_sg');
});

test('parseGeminiStatementResponse throws StatementParseError on unparseable text', () => {
  assert.throws(() => parseGeminiStatementResponse('not json at all'), StatementParseError);
});

test('parseGeminiStatementResponse throws StatementParseError on invalid JSON', () => {
  assert.throws(() => parseGeminiStatementResponse('{ broken json'), StatementParseError);
});

test('parseGeminiStatementResponse throws StatementParseError when broker is unrecognized', () => {
  assert.throws(
    () => parseGeminiStatementResponse('{"broker": null, "holdings": []}'),
    StatementParseError,
  );
});

test('parseGeminiStatementResponse throws StatementParseError when holdings is empty', () => {
  assert.throws(
    () => parseGeminiStatementResponse('{"broker": "ibkr", "holdings": []}'),
    StatementParseError,
  );
});

test('parseGeminiStatementResponse throws StatementParseError when a holding has a non-numeric or non-positive quantity', () => {
  const zeroQty = `{"broker": "ibkr", "holdings": [{"symbol": "AAPL", "name": "Apple Inc.", "quantity": 0, "asset_class": "stocks_us", "currency": "USD", "market": "NASDAQ"}]}`;
  assert.throws(() => parseGeminiStatementResponse(zeroQty), StatementParseError);

  const negativeQty = `{"broker": "ibkr", "holdings": [{"symbol": "AAPL", "name": "Apple Inc.", "quantity": -5, "asset_class": "stocks_us", "currency": "USD", "market": "NASDAQ"}]}`;
  assert.throws(() => parseGeminiStatementResponse(negativeQty), StatementParseError);

  const nonNumericQty = `{"broker": "ibkr", "holdings": [{"symbol": "AAPL", "name": "Apple Inc.", "quantity": "ten", "asset_class": "stocks_us", "currency": "USD", "market": "NASDAQ"}]}`;
  assert.throws(() => parseGeminiStatementResponse(nonNumericQty), StatementParseError);
});

test('parseGeminiStatementResponse throws StatementParseError when a holding has an unrecognized asset class', () => {
  const raw = `{"broker": "ibkr", "holdings": [{"symbol": "BTC", "name": "Bitcoin", "quantity": 1, "asset_class": "crypto", "currency": "USD", "market": "NASDAQ"}]}`;
  assert.throws(() => parseGeminiStatementResponse(raw), StatementParseError);
});

test('parseGeminiStatementResponse throws StatementParseError when a holding has an unrecognized currency', () => {
  const raw = `{"broker": "ibkr", "holdings": [{"symbol": "0700", "name": "Tencent", "quantity": 100, "asset_class": "stocks_us", "currency": "HKD", "market": "HKEX"}]}`;
  assert.throws(() => parseGeminiStatementResponse(raw), StatementParseError);
});

test('parseStatement surfaces a Gemini/network failure as StatementParseError, not a thrown network error', async () => {
  const originalFetch = global.fetch;
  global.fetch = (() => {
    throw new Error('simulated network failure');
  }) as typeof fetch;

  try {
    const { parseStatement } = await import('./statement-parser');
    await assert.rejects(() => parseStatement(userId, Buffer.from('%PDF-1.4 fake')), StatementParseError);
  } finally {
    global.fetch = originalFetch;
  }
});
