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
// This can be overridden by user configuration in user_config table
export const DEFAULT_CARD_CURRENCY_MAP: Record<string, Currency> = {
  'OCBC iPhone': 'SGD',
  'OCBC': 'SGD',
  'DBS': 'SGD',
  'UOB': 'SGD',
  'Maybank': 'MYR',
  'CIMB': 'MYR',
  'Crypto.com': 'USD',
  'Binance': 'USD',
  'Gemini': 'USD',
};

// DEPRECATED: Hardcoded exchange rates for backward compatibility only
// Use getExchangeRates() from ./exchange-rates.ts for live rates
// Values are in relation to SGD (1 SGD = ? currency)
export const EXCHANGE_RATES: Record<Currency, number> = {
  SGD: 1.0,
  MYR: 0.3,
  USD: 0.75,
  BTC: 0.000015,
  ETH: 0.00034,
  BETH: 0.00034,
};

/**
 * Convert amount from one currency to another (synchronous, uses static rates)
 * All amounts are in cents
 *
 * NOTE: This uses static fallback rates. For live rates, use convertCurrencyAsync() from ./exchange-rates.ts
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
 * NOTE: This uses static fallback rates. For live rates, consider refactoring to async
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
