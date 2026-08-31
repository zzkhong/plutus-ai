import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGeminiStatementResponse, StatementParseError } from './statement-parser';

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
    await assert.rejects(() => parseStatement(Buffer.from('%PDF-1.4 fake')), StatementParseError);
  } finally {
    global.fetch = originalFetch;
  }
});
