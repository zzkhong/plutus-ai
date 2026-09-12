import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Must precede anything that reaches src/config or src/db — see CLAUDE.md.
process.env.DATABASE_URL = './data/test-fx-rates.db';

const testDbPath = path.resolve('./data/test-fx-rates.db');
if (fs.existsSync(testDbPath)) {
  fs.rmSync(testDbPath, { force: true });
}

type RatesModule = typeof import('./rates');
let fx: RatesModule;
let clearStoredRates: () => Promise<void>;
const originalFetch = global.fetch;

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 8, 12, 4, 0, 0);

before(async () => {
  const { runMigrations } = await import('../db/migrate');
  await runMigrations();
  fx = await import('./rates');
  const { db } = await import('../db');
  const { fx_rates } = await import('../db/schema');
  clearStoredRates = async () => {
    await db.delete(fx_rates);
  };
});

beforeEach(async () => {
  fx._resetExchangeRateCache();
  await clearStoredRates();
  global.fetch = originalFetch;
});

after(() => {
  global.fetch = originalFetch;
});

function stubApi(body: Record<string, unknown> | 'throw' = successBody(0.79, 3.2)) {
  const urls: string[] = [];
  global.fetch = (async (url: string) => {
    urls.push(url);
    if (body === 'throw') {
      throw new Error('simulated network failure');
    }
    return { ok: true, status: 200, json: async () => body };
  }) as unknown as typeof fetch;
  return urls;
}

function successBody(usd: number, myr: number) {
  return {
    result: 'success',
    base_code: 'SGD',
    time_last_update_unix: 1789084801,
    conversion_rates: { SGD: 1, USD: usd, MYR: myr, EUR: 0.68 },
  };
}

test('fetches SGD-based rates, which are already units per 1 SGD', async () => {
  const urls = stubApi(successBody(0.79, 3.2));

  const rates = await fx.getExchangeRates({ apiKey: 'test-key', now: T0 });

  assert.deepEqual(rates, { SGD: 1, USD: 0.79, MYR: 3.2 });
  assert.equal(urls.length, 1);
  assert.match(urls[0], /\/v6\/test-key\/latest\/SGD$/);
});

test('answers repeat calls within a day from memory, without another request', async () => {
  const urls = stubApi();

  await fx.getExchangeRates({ apiKey: 'test-key', now: T0 });
  await fx.getExchangeRates({ apiKey: 'test-key', now: T0 + 6 * 60 * 60 * 1000 });

  assert.equal(urls.length, 1);
});

test('a fresh instance reuses the stored rates within the day instead of calling the API', async () => {
  const urls = stubApi();
  await fx.getExchangeRates({ apiKey: 'test-key', now: T0 });

  // What a new Vercel instance sees: empty memory, but the database row.
  fx._resetExchangeRateCache();
  const rates = await fx.getExchangeRates({ apiKey: 'test-key', now: T0 + 60 * 60 * 1000 });

  assert.equal(urls.length, 1);
  assert.equal(rates.USD, 0.79);
});

test('refreshes once the stored rates are more than a day old', async () => {
  stubApi(successBody(0.79, 3.2));
  await fx.getExchangeRates({ apiKey: 'test-key', now: T0 });

  fx._resetExchangeRateCache();
  const urls = stubApi(successBody(0.8, 3.25));
  const rates = await fx.getExchangeRates({ apiKey: 'test-key', now: T0 + DAY + 1 });

  assert.equal(urls.length, 1);
  assert.equal(rates.USD, 0.8);
});

test('keeps using the last stored rates, however old, when a refresh fails', async () => {
  stubApi(successBody(0.79, 3.2));
  await fx.getExchangeRates({ apiKey: 'test-key', now: T0 });

  fx._resetExchangeRateCache();
  stubApi('throw');
  const rates = await fx.getExchangeRates({ apiKey: 'test-key', now: T0 + 5 * DAY });

  assert.equal(rates.USD, 0.79);
});

test('does not retry a failed refresh on every call', async () => {
  const urls = stubApi('throw');

  await fx.getExchangeRates({ apiKey: 'test-key', now: T0 });
  await fx.getExchangeRates({ apiKey: 'test-key', now: T0 + 5 * 60 * 1000 });

  assert.equal(urls.length, 1);
});

test('uses the built-in rates, with no request, when there is no API key', async () => {
  const urls = stubApi();
  const { FALLBACK_EXCHANGE_RATES } = await import('../config/currencies');

  const rates = await fx.getExchangeRates({ apiKey: undefined, now: T0 });

  assert.deepEqual(rates, FALLBACK_EXCHANGE_RATES);
  assert.equal(urls.length, 0);
});

test('rejects an error response or a missing rate rather than storing it', async () => {
  const { FALLBACK_EXCHANGE_RATES } = await import('../config/currencies');

  stubApi({ result: 'error', 'error-type': 'invalid-key' });
  assert.deepEqual(await fx.getExchangeRates({ apiKey: 'bad-key', now: T0 }), FALLBACK_EXCHANGE_RATES);

  fx._resetExchangeRateCache();
  stubApi({ result: 'success', base_code: 'SGD', conversion_rates: { SGD: 1, USD: 0.79 } });
  assert.deepEqual(await fx.getExchangeRates({ apiKey: 'test-key', now: T0 + 2 * 60 * 60 * 1000 }), FALLBACK_EXCHANGE_RATES);
});
