/**
 * Currencies, card-to-currency mapping, and pure conversion math.
 *
 * Conversions take the rates explicitly. The live rates come from
 * src/fx/rates.ts (exchangerate-api.com, cached for a day); this file stays
 * free of I/O so it can be used and tested anywhere.
 */

import { Currency } from '../types';

// Supported currencies (ISO 4217)
export const CURRENCIES: Record<Currency, { symbol: string; name: string }> = {
  SGD: { symbol: 'S$', name: 'Singapore Dollar' },
  MYR: { symbol: 'RM', name: 'Malaysian Ringgit' },
  USD: { symbol: '$', name: 'US Dollar' },
};

export const SUPPORTED_CURRENCIES: Currency[] = ['SGD', 'MYR', 'USD'];

// Base currency for normalization
export const BASE_CURRENCY: Currency = 'SGD';

// Card to currency mapping
export const DEFAULT_CARD_CURRENCY_MAP: Record<string, Currency> = {
  'OCBC iPhone': 'SGD',
  'OCBC': 'SGD',
  'DBS': 'SGD',
  'UOB': 'SGD',
  'Crypto.com': 'USD',
  'Binance': 'USD',
  'Gemini': 'USD',
};

/** How many units of each currency 1 SGD buys. */
export type ExchangeRates = Record<Currency, number>;

/**
 * Used only until live rates have been fetched at least once — no
 * EXCHANGE_RATE_API_KEY, or the API unreachable on first use. Same direction
 * as the live rates: units per 1 SGD. MYR was once entered the other way
 * round (0.3), which turned RM 45 into S$150; currencies.test.ts guards
 * against that. Last set 2026-09-11.
 */
export const FALLBACK_EXCHANGE_RATES: ExchangeRates = {
  SGD: 1.0,
  MYR: 3.21,
  USD: 0.789,
};

/**
 * Convert an amount in cents from one currency to another, via SGD. Returns
 * NaN for a currency missing from `rates`; callers that must not propagate
 * NaN check Number.isFinite.
 */
export function convertCurrency(
  amount: number,
  fromCurrency: Currency,
  toCurrency: Currency,
  rates: ExchangeRates,
): number {
  if (fromCurrency === toCurrency) {
    return amount;
  }

  const amountInSGD = amount / rates[fromCurrency];
  const amountInTargetCurrency = amountInSGD * rates[toCurrency];

  return Math.round(amountInTargetCurrency);
}

/** Convert an amount in cents to SGD cents. */
export function toSGD(amount: number, currency: Currency, rates: ExchangeRates): number {
  return convertCurrency(amount, currency, 'SGD', rates);
}

/**
 * Format amount for display
 */
export function formatCurrency(amount: number, currency: Currency): string {
  const symbol = CURRENCIES[currency].symbol;
  const displayAmount = (amount / 100).toFixed(2);
  return `${symbol}${displayAmount}`;
}
