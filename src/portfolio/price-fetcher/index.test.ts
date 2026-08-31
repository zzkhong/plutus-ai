import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

function fakeHolding(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: '1',
    symbol: 'AAPL',
    name: 'Apple Inc.',
    asset_class: 'stocks_us',
    quantity: 10,
    currency: 'USD',
    market: 'NASDAQ',
    broker: 'ibkr',
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  } as any;
}

beforeEach(async () => {
  const { _clearPriceCache } = await import('./index');
  _clearPriceCache();
});

test('getPrice returns null for cash without calling fetch', async () => {
  const originalFetch = global.fetch;
  let fetchCalled = false;
  global.fetch = (async () => {
    fetchCalled = true;
    return { ok: true, json: async () => ({}) };
  }) as unknown as typeof fetch;

  try {
    const { getPrice } = await import('./index');
    const quote = await getPrice(fakeHolding({ asset_class: 'cash', broker: null }));
    assert.equal(quote, null);
    assert.equal(fetchCalled, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('getPrice dispatches crypto holdings to the CoinGecko fetcher', async () => {
  const originalFetch = global.fetch;
  let requestedUrl = '';
  global.fetch = (async (url: string) => {
    requestedUrl = url;
    return { ok: true, json: async () => ({ bitcoin: { usd: 65000, usd_24h_change: 1 } }) };
  }) as typeof fetch;

  try {
    const { getPrice } = await import('./index');
    const quote = await getPrice(fakeHolding({ symbol: 'BTC', asset_class: 'crypto', broker: null }));
    assert.ok(quote);
    assert.equal(quote!.price, 65000);
    assert.match(requestedUrl, /coingecko/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('getPrice caches a quote so a second call within the TTL does not refetch', async () => {
  const originalFetch = global.fetch;
  let callCount = 0;
  global.fetch = (async () => {
    callCount += 1;
    return {
      ok: true,
      json: async () => ({ chart: { result: [{ meta: { regularMarketPrice: 190, chartPreviousClose: 180 } }] } }),
    };
  }) as unknown as typeof fetch;

  try {
    const { getPrice } = await import('./index');
    const holding = fakeHolding();

    const first = await getPrice(holding);
    const second = await getPrice(holding);

    assert.ok(first);
    assert.deepEqual(second, first);
    assert.equal(callCount, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test('withTimeout resolves to null if the wrapped promise never settles within the deadline', async () => {
  const { withTimeout } = await import('./index');
  const hanging = new Promise(() => {
    // never resolves — simulates a hung network request
  });
  const start = Date.now();
  const result = await withTimeout(hanging, 20);
  const elapsed = Date.now() - start;

  assert.equal(result, null);
  // Bounded well under the 10s production timeout — proves the mechanism
  // resolves promptly on its own `ms` param, not the real network path.
  assert.ok(elapsed < 1000, `expected withTimeout to resolve quickly, took ${elapsed}ms`);
});
