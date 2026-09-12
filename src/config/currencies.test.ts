import test from 'node:test';
import assert from 'node:assert/strict';
import { convertCurrency, FALLBACK_EXCHANGE_RATES, SUPPORTED_CURRENCIES, toSGD } from './currencies';

// Every rate means "units of this currency per 1 SGD". The bounds on the
// fallback rates are loose on purpose: they catch a rate entered the wrong
// way round (MYR once was, which turned RM 45 into S$150), not ordinary drift.

const RATES = { SGD: 1, MYR: 3.2, USD: 0.8 };

test('toSGD divides by the per-SGD rate', () => {
  assert.equal(toSGD(3200, 'MYR', RATES), 1000); // RM 32 -> S$10
  assert.equal(toSGD(8000, 'USD', RATES), 10000); // US$80 -> S$100
  assert.equal(toSGD(1234, 'SGD', RATES), 1234);
});

test('convertCurrency converts between two non-SGD currencies via SGD', () => {
  // RM 32 = S$10 = US$8
  assert.equal(convertCurrency(3200, 'MYR', 'USD', RATES), 800);
});

test('the fallback rates cover every supported currency, with SGD as the base', () => {
  assert.equal(FALLBACK_EXCHANGE_RATES.SGD, 1);
  for (const currency of SUPPORTED_CURRENCIES) {
    const rate = FALLBACK_EXCHANGE_RATES[currency];
    assert.ok(Number.isFinite(rate) && rate > 0, `${currency} has rate ${rate}`);
  }
});

test('the fallback rates convert ringgit plausibly: RM 45 is roughly S$14, not S$150', () => {
  const sgd = toSGD(4500, 'MYR', FALLBACK_EXCHANGE_RATES) / 100;
  assert.ok(sgd > 10 && sgd < 20, `RM 45 converted to S$${sgd}`);
});

test('the fallback rates convert US dollars plausibly', () => {
  const sgd = toSGD(10000, 'USD', FALLBACK_EXCHANGE_RATES) / 100;
  assert.ok(sgd > 110 && sgd < 160, `US$100 converted to S$${sgd}`);
});
