import test from 'node:test';
import assert from 'node:assert/strict';
import { enrichHolding, calculateNetWorth, calculateAllocation, buildPortfolioSummary } from './calculator';
import { Holding, PriceQuote } from './types';
import { Currency } from '../types';

// Explicit rates keep these tests independent of live or fallback values.
const RATES = { SGD: 1, MYR: 3.2, USD: 0.8 };

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
    price: 100,
    price_as_of: new Date('2026-09-10T00:00:00'),
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function fakeQuote(overrides: Partial<PriceQuote> = {}): PriceQuote {
  return { price: 100, currency: 'USD', change_pct: null, as_of: new Date(), source: 'statement', ...overrides };
}

test('enrichHolding values a stock at quantity * price, converted from the quote currency at the given rates', () => {
  const enriched = enrichHolding(fakeHolding({ quantity: 10 }), fakeQuote({ price: 100, currency: 'USD' }), RATES);

  // 10 * US$100 = US$1000 -> 1000 / 0.8 = S$1250
  assert.equal(enriched.value_sgd, 125000);
});

test('enrichHolding uses whatever rates it is given', () => {
  const holding = fakeHolding({ quantity: 10 });
  const quote = fakeQuote({ price: 100, currency: 'USD' });

  const atPoint8 = enrichHolding(holding, quote, RATES).value_sgd;
  const atPoint75 = enrichHolding(holding, quote, { ...RATES, USD: 0.75 }).value_sgd;

  assert.ok(atPoint75 > atPoint8, 'a weaker SGD (fewer USD per SGD) makes USD holdings worth more SGD');
});

test('enrichHolding values a holding with no quote as 0', () => {
  const enriched = enrichHolding(fakeHolding(), null, RATES);

  assert.equal(enriched.value_sgd, 0);
  assert.equal(enriched.quote, null);
});

test('enrichHolding values cash at face value in its currency', () => {
  const sgdCash = enrichHolding(fakeHolding({ asset_class: 'cash', symbol: 'SGD', quantity: 5000, currency: 'SGD' }), null, RATES);
  const myrCash = enrichHolding(fakeHolding({ asset_class: 'cash', symbol: 'MYR', quantity: 32, currency: 'MYR' }), null, RATES);

  assert.equal(sgdCash.value_sgd, 500000); // S$5000
  assert.equal(myrCash.value_sgd, 1000); // RM 32 -> S$10
});

test('enrichHolding guards against an unrecognized currency slipping through, returning 0 instead of NaN', () => {
  const holding = fakeHolding({ currency: 'XXX' as Currency });
  const quote = fakeQuote({ currency: 'XXX' as Currency });

  assert.equal(enrichHolding(holding, quote, RATES).value_sgd, 0);
});

test('calculateNetWorth sums value_sgd across mixed holdings', () => {
  const holdings = [
    enrichHolding(fakeHolding({ symbol: 'A' }), fakeQuote(), RATES),
    enrichHolding(fakeHolding({ symbol: 'B', asset_class: 'cash', quantity: 1000, currency: 'SGD' }), null, RATES),
  ];

  assert.equal(calculateNetWorth(holdings), holdings[0].value_sgd + holdings[1].value_sgd);
});

test('calculateAllocation splits by class and currency with percentages summing to ~100', () => {
  const holdings = [
    enrichHolding(fakeHolding({ symbol: 'A', asset_class: 'stocks_us', currency: 'USD' }), fakeQuote({ price: 100 }), RATES),
    enrichHolding(
      fakeHolding({ symbol: 'B', asset_class: 'crypto', currency: 'USD', quantity: 1, broker: null }),
      fakeQuote({ price: 50, change_pct: 1, source: 'market' }),
      RATES,
    ),
  ];

  const { by_class, by_currency } = calculateAllocation(holdings);

  assert.ok(Math.abs(by_class.reduce((sum, e) => sum + e.pct, 0) - 100) < 0.2);
  assert.ok(Math.abs(by_currency.reduce((sum, e) => sum + e.pct, 0) - 100) < 0.2);
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
