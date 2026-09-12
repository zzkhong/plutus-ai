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

function stubSearch(response: { ok: boolean; json: unknown } | 'throw') {
  const originalFetch = global.fetch;
  const urls: string[] = [];
  global.fetch = (async (url: string) => {
    urls.push(url);
    if (response === 'throw') {
      throw new Error('simulated network failure');
    }
    return { ok: response.ok, json: async () => response.json };
  }) as unknown as typeof fetch;
  return { urls, restore: () => (global.fetch = originalFetch) };
}

test('searchCoins returns ranked coins with exactly that ticker, largest first', async () => {
  const net = stubSearch({
    ok: true,
    json: {
      coins: [
        { id: 'wif-copy', name: 'WIF Copy', symbol: 'WIF', market_cap_rank: null },
        { id: 'dogwifhat', name: 'dogwifhat', symbol: 'WIF', market_cap_rank: 80 },
        { id: 'wifi', name: 'WiFi Map', symbol: 'WIFI', market_cap_rank: 700 },
        { id: 'wif-2', name: 'Wif 2', symbol: 'wif', market_cap_rank: 3000 },
        { id: 'wif-3', name: 'Wif 3', symbol: 'WIF', market_cap_rank: 2500 },
        { id: 'wif-4', name: 'Wif 4', symbol: 'WIF', market_cap_rank: 4000 },
      ],
    },
  });
  try {
    const { searchCoins } = await import('./crypto');
    const coins = await searchCoins(' wif ');

    assert.match(net.urls[0], /api\.coingecko\.com\/api\/v3\/search\?query=WIF$/);
    assert.deepEqual(
      coins.map((coin) => [coin.id, coin.rank]),
      [
        ['dogwifhat', 80],
        ['wif-3', 2500],
        ['wif-2', 3000],
      ],
    );
  } finally {
    net.restore();
  }
});

test('searchCoins returns nothing when CoinGecko fails, rather than throwing', async () => {
  const { searchCoins } = await import('./crypto');

  const failed = stubSearch({ ok: false, json: {} });
  try {
    assert.deepEqual(await searchCoins('WIF'), []);
  } finally {
    failed.restore();
  }

  const thrown = stubSearch('throw');
  try {
    assert.deepEqual(await searchCoins('WIF'), []);
  } finally {
    thrown.restore();
  }
});

test('findCoinByRank finds the offered coin at that rank, however far down the list', async () => {
  const net = stubSearch({
    ok: true,
    json: {
      coins: [
        { id: 'a', name: 'A', symbol: 'ABC', market_cap_rank: 10 },
        { id: 'b', name: 'B', symbol: 'ABC', market_cap_rank: 20 },
        { id: 'c', name: 'C', symbol: 'ABC', market_cap_rank: 30 },
        { id: 'd', name: 'D', symbol: 'ABC', market_cap_rank: 40 },
      ],
    },
  });
  try {
    const { findCoinByRank } = await import('./crypto');
    assert.equal((await findCoinByRank('ABC', 40))?.id, 'd');
    assert.equal(await findCoinByRank('ABC', 50), null);
  } finally {
    net.restore();
  }
});

test('getCryptoPrice prices a coin by the id given, for coins outside the built-in table', async () => {
  const net = stubSearch({ ok: true, json: { dogwifhat: { usd: 1.85, usd_24h_change: 4 } } });
  try {
    const { getCryptoPrice } = await import('./crypto');
    const quote = await getCryptoPrice('WIF', 'dogwifhat');

    assert.equal(quote?.price, 1.85);
    assert.match(net.urls[0], /ids=dogwifhat&/);
  } finally {
    net.restore();
  }
});
