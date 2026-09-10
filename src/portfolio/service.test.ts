import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

process.env.DATABASE_URL = './data/test-portfolio-service.db';

const testDbPath = path.resolve('./data/test-portfolio-service.db');
if (fs.existsSync(testDbPath)) {
  fs.rmSync(testDbPath, { force: true });
}

let userId: string;

before(async () => {
  const { runMigrations } = await import('../db/migrate');
  runMigrations();
  const { createUser } = await import('../users/service');
  const user = await createUser('test-portfolio-service-chat');
  userId = user.id;
});

test('addHolding creates a new manual holding with broker null', async () => {
  const { addHolding } = await import('./service');
  const holding = await addHolding(userId, {
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
  await addHolding(userId, { symbol: 'ETH', name: 'Ethereum', quantity: 1, asset_class: 'crypto', currency: 'USD', market: 'Crypto' });
  await addHolding(userId, { symbol: 'ETH', name: 'Ethereum', quantity: 2, asset_class: 'crypto', currency: 'USD', market: 'Crypto' });

  const all = await listHoldings(userId);
  const ethHoldings = all.filter((h) => h.symbol === 'ETH');

  assert.equal(ethHoldings.length, 1);
  assert.equal(ethHoldings[0].quantity, 2);
});

test('removeHolding deletes only the manual holding with that symbol', async () => {
  const { addHolding, removeHolding, listHoldings } = await import('./service');
  await addHolding(userId, { symbol: 'DOGE', name: 'Dogecoin', quantity: 100, asset_class: 'crypto', currency: 'USD', market: 'Crypto' });
  await removeHolding(userId, 'DOGE');

  const all = await listHoldings(userId);
  assert.ok(!all.some((h) => h.symbol === 'DOGE'));
});

test('replaceHoldingsForBroker inserts fresh holdings tagged with that broker', async () => {
  const { replaceHoldingsForBroker } = await import('./service');
  const inserted = await replaceHoldingsForBroker(userId, 'ibkr', [
    { symbol: 'AAPL', name: 'Apple Inc.', quantity: 10, asset_class: 'stocks_us', currency: 'USD', market: 'NASDAQ' },
  ]);

  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].broker, 'ibkr');
  assert.equal(inserted[0].symbol, 'AAPL');
});

test('replaceHoldingsForBroker wipes only the target broker\'s rows, leaving other brokers and manual entries untouched', async () => {
  const { replaceHoldingsForBroker, addHolding, listHoldings } = await import('./service');

  await replaceHoldingsForBroker(userId, 'ibkr', [
    { symbol: 'MSFT', name: 'Microsoft', quantity: 5, asset_class: 'stocks_us', currency: 'USD', market: 'NASDAQ' },
  ]);
  await replaceHoldingsForBroker(userId, 'moomoo', [
    { symbol: 'SIA', name: 'Singapore Airlines', quantity: 100, asset_class: 'stocks_sg', currency: 'SGD', market: 'SGX' },
  ]);
  await addHolding(userId, { symbol: 'BNB', name: 'Binance Coin', quantity: 3, asset_class: 'crypto', currency: 'USD', market: 'Crypto' });

  await replaceHoldingsForBroker(userId, 'ibkr', [
    { symbol: 'GOOG', name: 'Alphabet', quantity: 2, asset_class: 'stocks_us', currency: 'USD', market: 'NASDAQ' },
  ]);

  const all = await listHoldings(userId);
  assert.ok(!all.some((h) => h.symbol === 'MSFT'), 'old IBKR position should be gone');
  assert.ok(all.some((h) => h.symbol === 'GOOG'), 'new IBKR position should be present');
  assert.ok(all.some((h) => h.symbol === 'SIA'), 'moomoo holding should be untouched');
  assert.ok(all.some((h) => h.symbol === 'BNB'), 'manual holding should be untouched');
});

test('replaceHoldingsForBroker rejects an empty holdings list', async () => {
  const { replaceHoldingsForBroker } = await import('./service');
  await assert.rejects(() => replaceHoldingsForBroker(userId, 'ibkr', []));
});

test('replaceHoldingsForBroker never touches another user\'s holdings for the same broker', async () => {
  const { createUser } = await import('../users/service');
  const { replaceHoldingsForBroker, listHoldings } = await import('./service');
  const otherUser = await createUser('test-portfolio-service-other-chat');

  await replaceHoldingsForBroker(otherUser.id, 'ibkr', [
    { symbol: 'TSLA', name: 'Tesla', quantity: 1, asset_class: 'stocks_us', currency: 'USD', market: 'NASDAQ' },
  ]);

  // Replacing the calling user's own ibkr holdings must not wipe the other user's TSLA row.
  await replaceHoldingsForBroker(userId, 'ibkr', [
    { symbol: 'GOOG', name: 'Alphabet', quantity: 2, asset_class: 'stocks_us', currency: 'USD', market: 'NASDAQ' },
  ]);

  const theirs = await listHoldings(otherUser.id);
  assert.ok(theirs.some((h) => h.symbol === 'TSLA'));
});
