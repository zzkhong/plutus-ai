import test from 'node:test';
import assert from 'node:assert/strict';

test('getStockPrice fetches a US symbol directly from Yahoo', async () => {
  const originalFetch = global.fetch;
  let requestedUrl = '';
  global.fetch = (async (url: string) => {
    requestedUrl = url;
    return {
      ok: true,
      json: async () => ({
        chart: { result: [{ meta: { regularMarketPrice: 190, chartPreviousClose: 180 } }] },
      }),
    };
  }) as typeof fetch;

  try {
    const { getStockPrice } = await import('./stocks');
    const quote = await getStockPrice('AAPL', 'stocks_us', 'USD');

    assert.ok(quote);
    assert.equal(quote!.price, 190);
    assert.equal(quote!.currency, 'USD');
    assert.ok(Math.abs(quote!.change_pct - 5.5556) < 0.01);
    assert.match(requestedUrl, /chart\/AAPL$/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('getStockPrice resolves a mapped MY symbol to its Yahoo .KL code before fetching', async () => {
  const { SYMBOL_MAP } = await import('./symbol-map');
  SYMBOL_MAP['MAYBANK'] = '1155.KL';

  const originalFetch = global.fetch;
  let requestedUrl = '';
  global.fetch = (async (url: string) => {
    requestedUrl = url;
    return {
      ok: true,
      json: async () => ({ chart: { result: [{ meta: { regularMarketPrice: 9.5, chartPreviousClose: 9.4 } }] } }),
    };
  }) as typeof fetch;

  try {
    const { getStockPrice } = await import('./stocks');
    const quote = await getStockPrice('MAYBANK', 'stocks_my', 'MYR');

    assert.ok(quote);
    assert.equal(quote!.price, 9.5);
    assert.match(requestedUrl, /chart\/1155\.KL$/);
  } finally {
    global.fetch = originalFetch;
    delete SYMBOL_MAP['MAYBANK'];
  }
});

test('getStockPrice returns null for an unmapped MY/SG symbol without calling fetch', async () => {
  const originalFetch = global.fetch;
  let fetchCalled = false;
  global.fetch = (async () => {
    fetchCalled = true;
    return { ok: true, json: async () => ({}) };
  }) as unknown as typeof fetch;

  try {
    const { getStockPrice } = await import('./stocks');
    const quote = await getStockPrice('UNKNOWN_CODE', 'stocks_sg', 'SGD');

    assert.equal(quote, null);
    assert.equal(fetchCalled, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('getStockPrice returns null when the response has no usable meta', async () => {
  const originalFetch = global.fetch;
  global.fetch = (async () => ({ ok: true, json: async () => ({ chart: { result: [] } }) })) as unknown as typeof fetch;

  try {
    const { getStockPrice } = await import('./stocks');
    const quote = await getStockPrice('AAPL', 'stocks_us', 'USD');
    assert.equal(quote, null);
  } finally {
    global.fetch = originalFetch;
  }
});

test('getStockPrice returns null when fetch throws', async () => {
  const originalFetch = global.fetch;
  global.fetch = (() => {
    throw new Error('simulated network failure');
  }) as typeof fetch;

  try {
    const { getStockPrice } = await import('./stocks');
    const quote = await getStockPrice('AAPL', 'stocks_us', 'USD');
    assert.equal(quote, null);
  } finally {
    global.fetch = originalFetch;
  }
});
