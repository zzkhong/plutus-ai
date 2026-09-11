/**
 * Currency constants and card-to-currency mapping
 */

import { Currency } from '../types';

// Supported currencies
export const CURRENCIES: Record<Currency, { symbol: string; name: string }> = {
  SGD: { symbol: 'S$', name: 'Singapore Dollar' },
  MYR: { symbol: 'RM', name: 'Malaysian Ringgit' },
  USD: { symbol: '$', name: 'US Dollar' },
  BTC: { symbol: '₿', name: 'Bitcoin' },
  ETH: { symbol: 'Ξ', name: 'Ethereum' },
  BETH: { symbol: 'Ξ', name: 'Beacon Ethereum' },
};

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

// Static exchange rates: how many units of each currency 1 SGD buys. Not
// fetched live — update by hand when they drift (last set 2026-09-11 from
// open.er-api.com and CoinGecko). Every entry must run the same direction:
// MYR was once entered the other way round (0.3), which turned RM 45 into
// S$150. currencies.test.ts guards against that.
export const EXCHANGE_RATES: Record<Currency, number> = {
  SGD: 1.0,
  MYR: 3.21,
  USD: 0.789,
  BTC: 0.0000102,
  ETH: 0.000307,
  BETH: 0.000307, // tracks ETH
};

/**
 * Convert amount from one currency to another (synchronous, uses static rates)
 * All amounts are in cents
 *
 * Uses the static EXCHANGE_RATES above.
 */
export function convertCurrency(
  amount: number,
  fromCurrency: Currency,
  toCurrency: Currency,
): number {
  if (fromCurrency === toCurrency) {
    return amount;
  }

  // Convert to SGD first, then to target currency
  const amountInSGD = amount / EXCHANGE_RATES[fromCurrency];
  const amountInTargetCurrency = amountInSGD * EXCHANGE_RATES[toCurrency];

  return Math.round(amountInTargetCurrency);
}

/**
 * Convert any amount to SGD (base currency) using static rates
 *
 * Uses the static EXCHANGE_RATES above.
 */
export function toSGD(amount: number, currency: Currency): number {
  return convertCurrency(amount, currency, 'SGD');
}

/**
 * Format amount for display
 */
export function formatCurrency(amount: number, currency: Currency): string {
  const symbol = CURRENCIES[currency].symbol;
  const displayAmount = (amount / 100).toFixed(2);
  return `${symbol}${displayAmount}`;
}
