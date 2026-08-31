import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

process.env.DATABASE_URL = './data/test-portfolio-service.db';

const testDbPath = path.resolve('./data/test-portfolio-service.db');
if (fs.existsSync(testDbPath)) {
  fs.rmSync(testDbPath, { force: true });
}

before(async () => {
  const { runMigrations } = await import('../db/migrate');
  runMigrations();
});

test('addHolding creates a new manual holding with broker null', async () => {
  const { addHolding } = await import('./service');
  const holding = await addHolding({
    symbol: 'BTC',
    name: 'Bitcoin',
    quantity: 0.5,
    asset_class: 'crypto',
    currency: 'USD',
    market: 'Crypto',
  });

  assert.equal(holding.symbol, 'BTC');
  assert.equal(holding.quantity, 0.5);
  assert.equal(holding.broker, null);
});

test('addHolding updates the existing manual holding for the same symbol instead of duplicating', async () => {
  const { addHolding, listHoldings } = await import('./service');
  await addHolding({ symbol: 'ETH', name: 'Ethereum', quantity: 1, asset_class: 'crypto', currency: 'USD', market: 'Crypto' });
  await addHolding({ symbol: 'ETH', name: 'Ethereum', quantity: 2, asset_class: 'crypto', currency: 'USD', market: 'Crypto' });

  const all = await listHoldings();
  const ethHoldings = all.filter((h) => h.symbol === 'ETH');

  assert.equal(ethHoldings.length, 1);
  assert.equal(ethHoldings[0].quantity, 2);
});

test('removeHolding deletes only the manual holding with that symbol', async () => {
  const { addHolding, removeHolding, listHoldings } = await import('./service');
  await addHolding({ symbol: 'DOGE', name: 'Dogecoin', quantity: 100, asset_class: 'crypto', currency: 'USD', market: 'Crypto' });
  await removeHolding('DOGE');

  const all = await listHoldings();
  assert.ok(!all.some((h) => h.symbol === 'DOGE'));
});

test('replaceHoldingsForBroker inserts fresh holdings tagged with that broker', async () => {
  const { replaceHoldingsForBroker } = await import('./service');
  const inserted = await replaceHoldingsForBroker('ibkr', [
    { symbol: 'AAPL', name: 'Apple Inc.', quantity: 10, asset_class: 'stocks_us', currency: 'USD', market: 'NASDAQ' },
  ]);

  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].broker, 'ibkr');
  assert.equal(inserted[0].symbol, 'AAPL');
});

test('replaceHoldingsForBroker wipes only the target broker\'s rows, leaving other brokers and manual entries untouched', async () => {
  const { replaceHoldingsForBroker, addHolding, listHoldings } = await import('./service');

  await replaceHoldingsForBroker('ibkr', [
    { symbol: 'MSFT', name: 'Microsoft', quantity: 5, asset_class: 'stocks_us', currency: 'USD', market: 'NASDAQ' },
  ]);
  await replaceHoldingsForBroker('moomoo', [
    { symbol: 'SIA', name: 'Singapore Airlines', quantity: 100, asset_class: 'stocks_sg', currency: 'SGD', market: 'SGX' },
  ]);
  await addHolding({ symbol: 'BNB', name: 'Binance Coin', quantity: 3, asset_class: 'crypto', currency: 'USD', market: 'Crypto' });

  // Re-upload a new IBKR statement with a different position.
  await replaceHoldingsForBroker('ibkr', [
    { symbol: 'GOOG', name: 'Alphabet', quantity: 2, asset_class: 'stocks_us', currency: 'USD', market: 'NASDAQ' },
  ]);

  const all = await listHoldings();
  assert.ok(!all.some((h) => h.symbol === 'MSFT'), 'old IBKR position should be gone');
  assert.ok(all.some((h) => h.symbol === 'GOOG'), 'new IBKR position should be present');
  assert.ok(all.some((h) => h.symbol === 'SIA'), 'moomoo holding should be untouched');
  assert.ok(all.some((h) => h.symbol === 'BNB'), 'manual holding should be untouched');
});

test('replaceHoldingsForBroker rejects an empty holdings list', async () => {
  const { replaceHoldingsForBroker } = await import('./service');
  await assert.rejects(() => replaceHoldingsForBroker('ibkr', []));
});
