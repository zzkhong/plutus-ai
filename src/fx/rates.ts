/**
 * Live exchange rates from exchangerate-api.com, cached for a day.
 *
 * Rates are "units of each currency per 1 SGD" — the API's SGD-based
 * response is already in that form. The cache has two layers: this
 * instance's memory, and the fx_rates row in the database. The database row
 * is what keeps the one-day TTL true on Vercel, where instances come and go:
 * a memory-only cache would call the API on nearly every cold start, and the
 * free plan allows 1,500 requests a month.
 *
 * Conversions never fail because the rate source is down. A failed refresh
 * falls back to the last stored rates however old they are, and with none
 * stored, to FALLBACK_EXCHANGE_RATES.
 */

import { eq } from 'drizzle-orm';
import { config } from '../config';
import { ExchangeRates, FALLBACK_EXCHANGE_RATES, SUPPORTED_CURRENCIES } from '../config/currencies';
import { db } from '../db';
import { fx_rates } from '../db/schema';
import { logger } from '../utils/logger';

export const RATES_TTL_MS = 24 * 60 * 60 * 1000;

// After a refresh fails (or with no API key), keep using what we have for
// this long before trying again, rather than retrying on every conversion.
const RETRY_AFTER_MS = 60 * 60 * 1000;

const FETCH_TIMEOUT_MS = 10_000;
const ROW_ID = 'SGD';

let memory: { rates: ExchangeRates; validUntil: number } | null = null;

export interface ExchangeRateOptions {
  /** Defaults to config.EXCHANGE_RATE_API_KEY; pass undefined explicitly for no key. */
  apiKey?: string;
  now?: number;
}

function validRates(candidate: Record<string, unknown> | undefined): ExchangeRates | null {
  if (!candidate) {
    return null;
  }
  const rates = {} as ExchangeRates;
  for (const currency of SUPPORTED_CURRENCIES) {
    const rate = candidate[currency];
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
      return null;
    }
    rates[currency] = rate;
  }
  return rates;
}

async function readStoredRates(): Promise<{ rates: ExchangeRates; fetchedAt: number } | null> {
  try {
    const row = await db.select().from(fx_rates).where(eq(fx_rates.id, ROW_ID)).get();
    if (!row) {
      return null;
    }
    const rates = validRates(JSON.parse(row.rates) as Record<string, unknown>);
    return rates ? { rates, fetchedAt: row.fetched_at } : null;
  } catch (error) {
    logger.warn('Could not read stored exchange rates', { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

async function storeRates(rates: ExchangeRates, fetchedAt: number): Promise<void> {
  const serialized = JSON.stringify(rates);
  await db
    .insert(fx_rates)
    .values({ id: ROW_ID, rates: serialized, fetched_at: fetchedAt })
    .onConflictDoUpdate({ target: fx_rates.id, set: { rates: serialized, fetched_at: fetchedAt } });
}

// Error messages here must never include the request URL: it contains the key.
async function fetchRates(apiKey: string): Promise<ExchangeRates> {
  const response = await fetch(`https://v6.exchangerate-api.com/v6/${encodeURIComponent(apiKey)}/latest/SGD`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`exchangerate-api responded with HTTP ${response.status}`);
  }

  const body = (await response.json()) as {
    result?: string;
    base_code?: string;
    conversion_rates?: Record<string, unknown>;
    'error-type'?: string;
  };
  if (body.result !== 'success' || body.base_code !== 'SGD') {
    throw new Error(`exchangerate-api returned ${body['error-type'] ?? 'an unexpected response'}`);
  }

  const rates = validRates(body.conversion_rates);
  if (!rates) {
    throw new Error(`exchangerate-api response is missing a rate for one of ${SUPPORTED_CURRENCIES.join(', ')}`);
  }
  return rates;
}

export async function getExchangeRates(options: ExchangeRateOptions = {}): Promise<ExchangeRates> {
  const now = options.now ?? Date.now();
  if (memory && now < memory.validUntil) {
    return memory.rates;
  }

  const stored = await readStoredRates();
  if (stored && now - stored.fetchedAt < RATES_TTL_MS) {
    memory = { rates: stored.rates, validUntil: stored.fetchedAt + RATES_TTL_MS };
    return stored.rates;
  }

  const apiKey = 'apiKey' in options ? options.apiKey : config.EXCHANGE_RATE_API_KEY;
  if (apiKey) {
    try {
      const fresh = await fetchRates(apiKey);
      await storeRates(fresh, now);
      memory = { rates: fresh, validUntil: now + RATES_TTL_MS };
      return fresh;
    } catch (error) {
      logger.warn('Exchange rate refresh failed; using the last known rates', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const rates = stored?.rates ?? FALLBACK_EXCHANGE_RATES;
  memory = { rates, validUntil: now + RETRY_AFTER_MS };
  return rates;
}

/** Test-only: forget this instance's in-memory rates. */
export function _resetExchangeRateCache(): void {
  memory = null;
}
