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

test('getStockPrice returns null for an SG/MY company name it cannot turn into a code, without calling fetch', async () => {
  const originalFetch = global.fetch;
  let fetchCalled = false;
  global.fetch = (async () => {
    fetchCalled = true;
    return { ok: true, json: async () => ({}) };
  }) as unknown as typeof fetch;

  try {
    const { getStockPrice } = await import('./stocks');
    const quote = await getStockPrice('DBS GROUP', 'stocks_sg', 'SGD');

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

function stubYahoo(meta: Record<string, unknown>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const originalFetch = global.fetch;
  global.fetch = (async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url, headers: init?.headers ?? {} });
    return { ok: true, json: async () => ({ chart: { result: [{ meta }] } }) };
  }) as unknown as typeof fetch;
  return {
    calls,
    restore: () => {
      global.fetch = originalFetch;
    },
  };
}

test('getStockPrice looks up an SGX stock by its exchange code plus .SI', async () => {
  const yahoo = stubYahoo({ regularMarketPrice: 77, chartPreviousClose: 76.79, currency: 'SGD' });
  try {
    const { getStockPrice } = await import('./stocks');
    const quote = await getStockPrice('D05', 'stocks_sg', 'SGD');
    assert.equal(quote?.price, 77);
    assert.match(yahoo.calls[0].url, /chart\/D05\.SI$/);
  } finally {
    yahoo.restore();
  }
});

test('getStockPrice looks up a Bursa stock by its numeric code plus .KL', async () => {
  const yahoo = stubYahoo({ regularMarketPrice: 10.38, chartPreviousClose: 10.46, currency: 'MYR' });
  try {
    const { getStockPrice } = await import('./stocks');
    const quote = await getStockPrice('1155', 'stocks_my', 'MYR');
    assert.equal(quote?.currency, 'MYR');
    assert.match(yahoo.calls[0].url, /chart\/1155\.KL$/);
  } finally {
    yahoo.restore();
  }
});

test('getStockPrice leaves a symbol that already carries the Yahoo suffix alone', async () => {
  const yahoo = stubYahoo({ regularMarketPrice: 6.66, chartPreviousClose: 6.66, currency: 'SGD' });
  try {
    const { getStockPrice } = await import('./stocks');
    await getStockPrice('c6l.si', 'stocks_sg', 'SGD');
    assert.match(yahoo.calls[0].url, /chart\/C6L\.SI$/);
  } finally {
    yahoo.restore();
  }
});

test("getStockPrice values the quote in Yahoo's currency, not the one the statement reported", async () => {
  const yahoo = stubYahoo({ regularMarketPrice: 77, chartPreviousClose: 77, currency: 'SGD' });
  try {
    const { getStockPrice } = await import('./stocks');
    const quote = await getStockPrice('D05', 'stocks_sg', 'USD');
    assert.equal(quote?.currency, 'SGD');
  } finally {
    yahoo.restore();
  }
});

test('getStockPrice returns null when Yahoo quotes in a currency the app has no rate for', async () => {
  const yahoo = stubYahoo({ regularMarketPrice: 300, chartPreviousClose: 300, currency: 'HKD' });
  try {
    const { getStockPrice } = await import('./stocks');
    assert.equal(await getStockPrice('0700', 'stocks_sg', 'SGD'), null);
  } finally {
    yahoo.restore();
  }
});

test('getStockPrice sends a User-Agent, since Yahoo answers requests without one with 429', async () => {
  const yahoo = stubYahoo({ regularMarketPrice: 1, chartPreviousClose: 1 });
  try {
    const { getStockPrice } = await import('./stocks');
    await getStockPrice('AAPL', 'stocks_us', 'USD');
    assert.ok(yahoo.calls[0].headers['User-Agent']);
  } finally {
    yahoo.restore();
  }
});

test('getStockPrice reports 0% change rather than Infinity when there is no previous close', async () => {
  const yahoo = stubYahoo({ regularMarketPrice: 5, chartPreviousClose: 0 });
  try {
    const { getStockPrice } = await import('./stocks');
    const quote = await getStockPrice('AAPL', 'stocks_us', 'USD');
    assert.equal(quote?.price, 5);
    assert.equal(quote?.change_pct, 0);
  } finally {
    yahoo.restore();
  }
});
