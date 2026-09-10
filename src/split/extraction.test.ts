import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

process.env.DATABASE_URL = './data/test-split-extraction.db';

const testDbPath = path.resolve('./data/test-split-extraction.db');
if (fs.existsSync(testDbPath)) {
  fs.rmSync(testDbPath, { force: true });
}

// extraction.ts now imports ../users/service -> ../db (client.ts), whose
// module-level `export const db = getDb()` eagerly opens/migrates a
// connection using config.DATABASE_URL at *import* time. tsx/esbuild hoists
// static imports above all other top-level code regardless of source
// position, so a static `import ... from './extraction'` here — even placed
// after the process.env.DATABASE_URL assignment above — would still resolve
// before that assignment runs and silently connect to the real dev
// ./data/pluto.db instead of this test's db. Importing dynamically inside
// before() (which runs after the assignment) avoids that.
type ExtractionModule = typeof import('./extraction');
let parseGeminiReceiptResponse: ExtractionModule['parseGeminiReceiptResponse'];
let ExtractionError: ExtractionModule['ExtractionError'];
let userId: string;

before(async () => {
  const { runMigrations } = await import('../db/migrate');
  runMigrations();
  const { createUser, setProvider, completeSetup } = await import('../users/service');
  const { encrypt } = await import('../users/crypto');
  const user = await createUser('test-split-extraction-chat');
  await setProvider(user.id, 'gemini');
  await completeSetup(user.id, encrypt('fake-key-for-tests'), true);
  userId = user.id;

  const extractionModule = await import('./extraction');
  parseGeminiReceiptResponse = extractionModule.parseGeminiReceiptResponse;
  ExtractionError = extractionModule.ExtractionError;
});

test('parseGeminiReceiptResponse maps a valid receipt JSON response', () => {
  const raw = `Here you go:\n{"merchant": "Ya Kun", "items": [{"name": "Kaya Toast Set", "price": 5.8}, {"name": "Iced Milo", "price": 3.2}], "taxAndTip": 0.9, "total": 9.9, "currency": "SGD"}`;

  const result = parseGeminiReceiptResponse(raw);

  assert.equal(result.merchant, 'Ya Kun');
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].name, 'Kaya Toast Set');
  assert.equal(result.taxAndTip, 0.9);
  assert.equal(result.total, 9.9);
  assert.equal(result.currency, 'SGD');
});

test('parseGeminiReceiptResponse defaults merchant to null when blank or missing', () => {
  const raw = `{"merchant": "", "items": [{"name": "Coffee", "price": 4}], "taxAndTip": 0, "total": 4, "currency": "SGD"}`;
  const result = parseGeminiReceiptResponse(raw);
  assert.equal(result.merchant, null);
});

test('parseGeminiReceiptResponse throws ExtractionError on unparseable text', () => {
  assert.throws(() => parseGeminiReceiptResponse('not json at all'), ExtractionError);
});

test('parseGeminiReceiptResponse throws ExtractionError on invalid JSON', () => {
  assert.throws(() => parseGeminiReceiptResponse('{ broken json'), ExtractionError);
});

test('parseGeminiReceiptResponse throws ExtractionError when items is empty', () => {
  assert.throws(
    () => parseGeminiReceiptResponse('{"merchant": null, "items": [], "taxAndTip": 0, "total": 0, "currency": "SGD"}'),
    ExtractionError,
  );
});

test('parseGeminiReceiptResponse throws ExtractionError when an item has a non-positive price', () => {
  const raw = `{"merchant": null, "items": [{"name": "Coffee", "price": 0}], "taxAndTip": 0, "total": 4, "currency": "SGD"}`;
  assert.throws(() => parseGeminiReceiptResponse(raw), ExtractionError);
});

test('parseGeminiReceiptResponse throws ExtractionError on an unrecognized currency', () => {
  const raw = `{"merchant": null, "items": [{"name": "Coffee", "price": 4}], "taxAndTip": 0, "total": 4, "currency": "HKD"}`;
  assert.throws(() => parseGeminiReceiptResponse(raw), ExtractionError);
});

test('parseGeminiReceiptResponse throws ExtractionError on a missing/invalid total', () => {
  const raw = `{"merchant": null, "items": [{"name": "Coffee", "price": 4}], "taxAndTip": 0, "total": 0, "currency": "SGD"}`;
  assert.throws(() => parseGeminiReceiptResponse(raw), ExtractionError);
});

test('parseGeminiReceiptResponse merges duplicate-named items instead of dropping one', () => {
  const raw = `{"merchant": "Cafe", "items": [{"name": "Iced Milo", "price": 3.2}, {"name": "Toast", "price": 5}, {"name": "Iced Milo", "price": 3.2}], "taxAndTip": 0, "total": 11.4, "currency": "SGD"}`;

  const result = parseGeminiReceiptResponse(raw);

  assert.equal(result.items.length, 2);
  const milo = result.items.find((i) => i.name === 'Iced Milo');
  assert.equal(milo?.price, 6.4);
});

test('parseGeminiReceiptResponse throws ExtractionError when items+taxAndTip and total disagree beyond tolerance', () => {
  const raw = `{"merchant": null, "items": [{"name": "Coffee", "price": 4}], "taxAndTip": 0, "total": 20, "currency": "SGD"}`;
  assert.throws(() => parseGeminiReceiptResponse(raw), ExtractionError);
});

test('extractReceipt surfaces a Gemini/network failure as ExtractionError, not a thrown network error', async () => {
  const originalFetch = global.fetch;
  global.fetch = (() => {
    throw new Error('simulated network failure');
  }) as typeof fetch;

  try {
    const { extractReceipt } = await import('./extraction');
    await assert.rejects(() => extractReceipt(userId, Buffer.from('fake jpeg'), 'image/jpeg'), ExtractionError);
  } finally {
    global.fetch = originalFetch;
  }
});
