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
    price: 326.57,
    price_as_of: new Date('2026-09-10T00:00:00'),
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  } as any;
}

function stubFetch(json: unknown) {
  const originalFetch = global.fetch;
  const urls: string[] = [];
  global.fetch = (async (url: string) => {
    urls.push(url);
    return { ok: true, json: async () => json };
  }) as unknown as typeof fetch;
  return {
    urls,
    restore: () => {
      global.fetch = originalFetch;
    },
  };
}

beforeEach(async () => {
  const { _clearPriceCache } = await import('./index');
  _clearPriceCache();
});

test('getPrice values a stock at its statement price, with no network call', async () => {
  const net = stubFetch({});
  try {
    const { getPrice } = await import('./index');
    const quote = await getPrice(fakeHolding());

    assert.equal(quote?.price, 326.57);
    assert.equal(quote?.currency, 'USD');
    assert.equal(quote?.source, 'statement');
    assert.equal(quote?.change_pct, null);
    assert.equal(quote?.as_of.getTime(), new Date('2026-09-10T00:00:00').getTime());
    assert.equal(net.urls.length, 0);
  } finally {
    net.restore();
  }
});

test('getPrice returns null for a stock with no statement price', async () => {
  const net = stubFetch({});
  try {
    const { getPrice } = await import('./index');
    assert.equal(await getPrice(fakeHolding({ price: null })), null);
    assert.equal(net.urls.length, 0);
  } finally {
    net.restore();
  }
});

test('getPrice returns null for cash without calling fetch', async () => {
  const net = stubFetch({});
  try {
    const { getPrice } = await import('./index');
    assert.equal(await getPrice(fakeHolding({ asset_class: 'cash', broker: null, price: null })), null);
    assert.equal(net.urls.length, 0);
  } finally {
    net.restore();
  }
});

test('getPrice prices crypto live from CoinGecko', async () => {
  const net = stubFetch({ bitcoin: { usd: 65000, usd_24h_change: 1 } });
  try {
    const { getPrice } = await import('./index');
    const quote = await getPrice(fakeHolding({ symbol: 'BTC', asset_class: 'crypto', broker: null, price: null }));

    assert.equal(quote?.price, 65000);
    assert.equal(quote?.source, 'market');
    assert.match(net.urls[0], /coingecko/);
  } finally {
    net.restore();
  }
});

test('getPrice caches a crypto quote so a second call within the TTL does not refetch', async () => {
  const net = stubFetch({ ethereum: { usd: 2500, usd_24h_change: -1 } });
  try {
    const { getPrice } = await import('./index');
    const holding = fakeHolding({ symbol: 'ETH', asset_class: 'crypto', broker: null, price: null });

    const first = await getPrice(holding);
    const second = await getPrice(holding);

    assert.ok(first);
    assert.deepEqual(second, first);
    assert.equal(net.urls.length, 1);
  } finally {
    net.restore();
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
  assert.ok(elapsed < 1000, `expected withTimeout to resolve quickly, took ${elapsed}ms`);
});
