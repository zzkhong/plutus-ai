/**
 * Exchange rate fetching service with caching
 *
 * TODO: Replace placeholder with actual API integration
 * Options:
 * - exchangerate-api.com (free tier: 1500 requests/month)
 * - fixer.io (free tier: 100 requests/month)
 * - Google Sheets API (custom managed rates)
 * - currencyapi.com
 */

import { Currency } from '../types';
import { logger } from '../utils/logger';

// Fallback rates (used when API is unavailable)
const FALLBACK_RATES: Record<Currency, number> = {
  SGD: 1.0,
  MYR: 0.3,
  USD: 0.75,
  BTC: 0.000015,
  ETH: 0.00034,
  BETH: 0.00034,
};

interface ExchangeRateCache {
  rates: Record<Currency, number>;
  lastUpdated: number;
}

let rateCache: ExchangeRateCache = {
  rates: FALLBACK_RATES,
  lastUpdated: 0,
};

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Fetch exchange rates from API (placeholder implementation)
 *
 * @returns Exchange rates relative to SGD
 */
async function fetchExchangeRatesFromAPI(): Promise<Record<Currency, number>> {
  // PLACEHOLDER: Replace with actual API call
  // Example implementation for exchangerate-api.com:
  //
  // const API_KEY = process.env.EXCHANGE_RATE_API_KEY;
  // const response = await fetch(
  //   `https://v6.exchangerate-api.com/v6/${API_KEY}/latest/SGD`
  // );
  // const data = await response.json();
  // return {
  //   SGD: 1.0,
  //   MYR: data.conversion_rates.MYR,
  //   USD: data.conversion_rates.USD,
  //   BTC: ... // fetch from crypto API
  //   ETH: ... // fetch from crypto API
  //   BETH: ... // fetch from crypto API
  // };

  logger.info('Exchange rate API fetch called (placeholder - returning fallback rates)');

  // For now, return fallback rates
  return FALLBACK_RATES;
}

/**
 * Get current exchange rates (with caching)
 * Rates are cached for 24 hours and refreshed automatically
 */
export async function getExchangeRates(): Promise<Record<Currency, number>> {
  const now = Date.now();
  const cacheAge = now - rateCache.lastUpdated;

  // Return cached rates if still valid
  if (cacheAge < CACHE_TTL_MS && rateCache.lastUpdated > 0) {
    return rateCache.rates;
  }

  // Fetch fresh rates
  try {
    const freshRates = await fetchExchangeRatesFromAPI();
    rateCache = {
      rates: freshRates,
      lastUpdated: now,
    };
    logger.info('Exchange rates refreshed successfully');
    return freshRates;
  } catch (error) {
    logger.error('Failed to fetch exchange rates, using fallback', error);
    // Return cached rates (even if stale) or fallback
    return rateCache.rates;
  }
}

/**
 * Get a specific exchange rate for a currency pair
 */
export async function getExchangeRate(fromCurrency: Currency, toCurrency: Currency): Promise<number> {
  if (fromCurrency === toCurrency) {
    return 1.0;
  }

  const rates = await getExchangeRates();

  // Convert through SGD as base
  const amountInSGD = 1 / rates[fromCurrency];
  const rateToTarget = amountInSGD * rates[toCurrency];

  return rateToTarget;
}

/**
 * Manually refresh exchange rates (useful for testing or manual updates)
 */
export async function refreshExchangeRates(): Promise<void> {
  rateCache.lastUpdated = 0; // Force refresh
  await getExchangeRates();
}
