/**
 * Unified price fetching across asset classes, with a short in-memory
 * TTL cache (mirroring src/config/exchange-rates.ts — no DB-backed cache).
 */

import { Holding, PriceQuote } from '../types';
import { getCryptoPrice } from './crypto';
import { getStockPrice } from './stocks';

interface CacheEntry {
  quote: PriceQuote;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

const STOCK_TTL_MS = 15 * 60 * 1000;
const CRYPTO_TTL_MS = 5 * 60 * 1000;

// Neither getCryptoPrice (CoinGecko) nor getStockPrice (Yahoo Finance) sets a
// fetch timeout, so a hung network request would otherwise block forever
// instead of degrading to null like the rest of their "never throw" contract.
// Bounding it here, once, avoids duplicating timeout logic in both fetchers.
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Races `promise` against a timer; resolves to `null` if `ms` elapses first.
 * Exported for direct unit testing (see index.test.ts) — otherwise internal.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function cacheKey(holding: Holding): string {
  return `${holding.asset_class}:${holding.symbol}`;
}

export async function getPrice(holding: Holding): Promise<PriceQuote | null> {
  if (holding.asset_class === 'cash') {
    return null;
  }

  const key = cacheKey(holding);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.quote;
  }

  let quote: PriceQuote | null;
  let ttl: number;

  if (holding.asset_class === 'crypto') {
    quote = await withTimeout(getCryptoPrice(holding.symbol as 'BTC' | 'ETH' | 'BETH'), FETCH_TIMEOUT_MS);
    ttl = CRYPTO_TTL_MS;
  } else {
    quote = await withTimeout(getStockPrice(holding.symbol, holding.asset_class, holding.currency), FETCH_TIMEOUT_MS);
    ttl = STOCK_TTL_MS;
  }

  if (quote) {
    cache.set(key, { quote, expiresAt: Date.now() + ttl });
  }

  return quote;
}

/** Test-only: reset cache state between test cases. */
export function _clearPriceCache(): void {
  cache.clear();
}
