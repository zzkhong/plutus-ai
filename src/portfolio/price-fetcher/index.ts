/**
 * Prices for valuing holdings.
 *
 * - Stocks and ETFs are valued at the price on the user's latest statement
 *   from that broker, stored on the holding at import. There's no live stock
 *   quote; a newer statement replaces the price.
 * - Crypto is priced live from CoinGecko, with a short in-memory TTL cache
 *   (per function instance on Vercel, which just means refetching).
 * - Cash has no price; it's valued at face value.
 */

import { Holding, PriceQuote } from '../types';
import { getCryptoPrice } from './crypto';

interface CacheEntry {
  quote: PriceQuote;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

const CRYPTO_TTL_MS = 5 * 60 * 1000;

// getCryptoPrice sets no fetch timeout, so a hung request would otherwise
// block instead of degrading to null like the rest of its "never throw"
// contract.
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Races `promise` against a timer; resolves to `null` if `ms` elapses first.
 * Exported for direct unit testing (see index.test.ts) — otherwise internal.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function statementQuote(holding: Holding): PriceQuote | null {
  if (holding.price === null || holding.price === undefined) {
    return null;
  }
  return {
    price: holding.price,
    currency: holding.currency,
    change_pct: null,
    as_of: holding.price_as_of ?? holding.updated_at,
    source: 'statement',
  };
}

export async function getPrice(holding: Holding): Promise<PriceQuote | null> {
  if (holding.asset_class === 'cash') {
    return null;
  }

  if (holding.asset_class !== 'crypto') {
    return statementQuote(holding);
  }

  // A coin the user picked on CoinGecko is priced by that id; otherwise by the built-in table.
  const key = `crypto:${holding.coingecko_id ?? holding.symbol}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.quote;
  }

  const quote = await withTimeout(getCryptoPrice(holding.symbol, holding.coingecko_id ?? undefined), FETCH_TIMEOUT_MS);
  if (quote) {
    cache.set(key, { quote, expiresAt: Date.now() + CRYPTO_TTL_MS });
  }
  return quote;
}

/** Test-only: reset cache state between test cases. */
export function _clearPriceCache(): void {
  cache.clear();
}
