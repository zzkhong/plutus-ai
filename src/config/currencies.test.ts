import test from 'node:test';
import assert from 'node:assert/strict';
import { EXCHANGE_RATES, toSGD } from './currencies';

// Every rate means "units of this currency per 1 SGD". These bounds are loose
// on purpose: they catch a rate entered the wrong way round (MYR once was,
// which turned RM 45 into S$150), not ordinary drift.

test('SGD is the base currency', () => {
  assert.equal(EXCHANGE_RATES.SGD, 1);
});

test('every rate is a positive number', () => {
  for (const [currency, rate] of Object.entries(EXCHANGE_RATES)) {
    assert.ok(Number.isFinite(rate) && rate > 0, `${currency} has rate ${rate}`);
  }
});

test('toSGD converts ringgit at a plausible rate: RM 45 is roughly S$14, not S$150', () => {
  const sgd = toSGD(4500, 'MYR') / 100;
  assert.ok(sgd > 10 && sgd < 20, `RM 45 converted to S$${sgd}`);
});

test('toSGD converts US dollars at a plausible rate', () => {
  const sgd = toSGD(10000, 'USD') / 100;
  assert.ok(sgd > 110 && sgd < 160, `US$100 converted to S$${sgd}`);
});

test('toSGD values one bitcoin and one ether in a plausible SGD range', () => {
  // Amounts are in hundredths of a unit, like cents.
  const btc = toSGD(100, 'BTC') / 100;
  const eth = toSGD(100, 'ETH') / 100;
  assert.ok(btc > 10_000, `1 BTC converted to S$${btc}`);
  assert.ok(eth > 500 && eth < btc, `1 ETH converted to S$${eth}`);
});
