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

test('getCryptoPrice uses the binance-staked-eth id for BETH', async () => {
  const originalFetch = global.fetch;
  let requestedUrl = '';
  global.fetch = (async (url: string) => {
    requestedUrl = url;
    return { ok: true, json: async () => ({ 'binance-staked-eth': { usd: 3000, usd_24h_change: -1 } }) };
  }) as typeof fetch;

  try {
    const { getCryptoPrice } = await import('./crypto');
    const quote = await getCryptoPrice('BETH');
    assert.ok(quote);
    assert.equal(quote!.price, 3000);
    assert.match(requestedUrl, /ids=binance-staked-eth/);
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
