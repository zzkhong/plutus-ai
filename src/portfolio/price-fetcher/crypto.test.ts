import test from 'node:test';
import assert from 'node:assert/strict';

test('getCryptoPrice returns price and 24h change on a successful call', async () => {
  const originalFetch = global.fetch;
  let requestedUrl = '';
  global.fetch = (async (url: string) => {
    requestedUrl = url;
    return {
      ok: true,
      json: async () => ({ bitcoin: { usd: 65000, usd_24h_change: 2.5 } }),
    };
  }) as typeof fetch;

  try {
    const { getCryptoPrice } = await import('./crypto');
    const quote = await getCryptoPrice('BTC');

    assert.ok(quote);
    assert.equal(quote!.price, 65000);
    assert.equal(quote!.currency, 'USD');
    assert.equal(quote!.change_pct, 2.5);
    assert.match(requestedUrl, /ids=bitcoin/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('getCryptoPrice uses the binance-eth id for BETH (binance-staked-eth does not exist on CoinGecko)', async () => {
  const originalFetch = global.fetch;
  let requestedUrl = '';
  global.fetch = (async (url: string) => {
    requestedUrl = url;
    return { ok: true, json: async () => ({ 'binance-eth': { usd: 3000, usd_24h_change: -1 } }) };
  }) as typeof fetch;

  try {
    const { getCryptoPrice } = await import('./crypto');
    const quote = await getCryptoPrice('BETH');
    assert.ok(quote);
    assert.equal(quote!.price, 3000);
    assert.match(requestedUrl, /ids=binance-eth&/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('getCryptoPrice returns null when the response is not ok', async () => {
  const originalFetch = global.fetch;
  global.fetch = (async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch;

  try {
    const { getCryptoPrice } = await import('./crypto');
    const quote = await getCryptoPrice('ETH');
    assert.equal(quote, null);
  } finally {
    global.fetch = originalFetch;
  }
});

test('getCryptoPrice returns null when fetch throws', async () => {
  const originalFetch = global.fetch;
  global.fetch = (() => {
    throw new Error('simulated network failure');
  }) as typeof fetch;

  try {
    const { getCryptoPrice } = await import('./crypto');
    const quote = await getCryptoPrice('BTC');
    assert.equal(quote, null);
  } finally {
    global.fetch = originalFetch;
  }
});

test('getCryptoPrice prices other listed coins, whatever the case of the symbol', async () => {
  const originalFetch = global.fetch;
  let requestedUrl = '';
  global.fetch = (async (url: string) => {
    requestedUrl = url;
    return { ok: true, json: async () => ({ solana: { usd: 150, usd_24h_change: 1 } }) };
  }) as typeof fetch;

  try {
    const { getCryptoPrice } = await import('./crypto');
    const quote = await getCryptoPrice('sol');
    assert.equal(quote?.price, 150);
    assert.match(requestedUrl, /ids=solana&/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('getCryptoPrice returns null for an unlisted coin without calling CoinGecko', async () => {
  const originalFetch = global.fetch;
  let fetchCalled = false;
  global.fetch = (async () => {
    fetchCalled = true;
    return { ok: true, json: async () => ({}) };
  }) as unknown as typeof fetch;

  try {
    const { getCryptoPrice } = await import('./crypto');
    assert.equal(await getCryptoPrice('FOOCOIN'), null);
    assert.equal(fetchCalled, false, 'an unlisted coin used to be sent to CoinGecko as ids=undefined');
  } finally {
    global.fetch = originalFetch;
  }
});

test('isPricedCrypto reports which coins have a price source', async () => {
  const { isPricedCrypto } = await import('./crypto');
  assert.equal(isPricedCrypto('BTC'), true);
  assert.equal(isPricedCrypto('wbeth'), true);
  assert.equal(isPricedCrypto('AAPL'), false);
  assert.equal(isPricedCrypto('constructor'), false);
});
