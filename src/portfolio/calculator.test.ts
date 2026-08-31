import test from 'node:test';
import assert from 'node:assert/strict';
import { enrichHolding, calculateNetWorth, calculateAllocation, buildPortfolioSummary } from './calculator';
import { Holding, PriceQuote } from './types';

function fakeHolding(overrides: Partial<Holding> = {}): Holding {
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
  };
}

function fakeQuote(overrides: Partial<PriceQuote> = {}): PriceQuote {
  return { price: 100, currency: 'USD', change_pct: 1, as_of: new Date(), ...overrides };
}

test('enrichHolding values a stock holding in SGD cents using quantity * price, converted from the quote currency', () => {
  const holding = fakeHolding({ quantity: 10, currency: 'USD' });
  const quote = fakeQuote({ price: 100, currency: 'USD' }); // 10 * 100 = 1000 USD

  const enriched = enrichHolding(holding, quote);

  // USD -> SGD at the static EXCHANGE_RATES rate (USD: 0.75 means 1 SGD = 0.75 USD,
  // so 1000 USD -> 1000 / 0.75 = 1333.33 SGD -> 133333 cents, rounded).
  assert.equal(enriched.value_sgd, Math.round((1000 / 0.75) * 100));
  assert.equal(enriched.quote, quote);
});

test('enrichHolding values a holding with no quote as 0', () => {
  const holding = fakeHolding();
  const enriched = enrichHolding(holding, null);

  assert.equal(enriched.value_sgd, 0);
  assert.equal(enriched.quote, null);
});

test('enrichHolding values cash directly from quantity, ignoring quote', () => {
  const holding = fakeHolding({ asset_class: 'cash', symbol: 'SGD', quantity: 5000, currency: 'SGD' });
  const enriched = enrichHolding(holding, null);

  assert.equal(enriched.value_sgd, 500000); // S$5000 -> 500000 cents
});

test('calculateNetWorth sums value_sgd across mixed holdings', () => {
  const holdings = [
    enrichHolding(fakeHolding({ symbol: 'A' }), fakeQuote()),
    enrichHolding(fakeHolding({ symbol: 'B', asset_class: 'cash', quantity: 1000, currency: 'SGD' }), null),
  ];

  const netWorth = calculateNetWorth(holdings);
  assert.equal(netWorth, holdings[0].value_sgd + holdings[1].value_sgd);
});

test('calculateAllocation splits by class and currency with percentages summing to ~100', () => {
  const holdings = [
    enrichHolding(fakeHolding({ symbol: 'A', asset_class: 'stocks_us', currency: 'USD' }), fakeQuote({ price: 100 })),
    enrichHolding(fakeHolding({ symbol: 'B', asset_class: 'crypto', currency: 'USD', quantity: 1 }), fakeQuote({ price: 50 })),
  ];

  const { by_class, by_currency } = calculateAllocation(holdings);

  const classTotal = by_class.reduce((sum, e) => sum + e.pct, 0);
  const currencyTotal = by_currency.reduce((sum, e) => sum + e.pct, 0);

  assert.ok(Math.abs(classTotal - 100) < 0.2);
  assert.ok(Math.abs(currencyTotal - 100) < 0.2);
  assert.ok(by_class.some((e) => e.key === 'stocks_us'));
  assert.ok(by_class.some((e) => e.key === 'crypto'));
});

test('buildPortfolioSummary composes net worth, allocation, and holdings; empty input yields zeros', () => {
  const summary = buildPortfolioSummary([]);
  assert.equal(summary.net_worth_sgd, 0);
  assert.deepEqual(summary.by_class, []);
  assert.deepEqual(summary.by_currency, []);
  assert.deepEqual(summary.holdings, []);
});
