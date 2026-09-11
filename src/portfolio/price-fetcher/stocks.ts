/**
 * US/MY/SG stock prices via Yahoo Finance's unofficial chart API.
 *
 * US tickers are used as-is. SGX and Bursa stocks are looked up by their
 * exchange code plus Yahoo's suffix — `D05` → `D05.SI` (DBS), `1155` →
 * `1155.KL` (Maybank) — after checking SYMBOL_MAP for manual overrides. A
 * company name can't be resolved that way, so it degrades to "price
 * unavailable" rather than guessing.
 */

import { AssetClass, Currency } from '../../types';
import { PriceQuote } from '../types';
import { resolveYahooSymbol } from './symbol-map';

const YAHOO_SUFFIX: Partial<Record<AssetClass, string>> = {
  stocks_sg: '.SI',
  stocks_my: '.KL',
};

// SGX codes (D05, C6L, Z74) and Bursa codes (1155) — not company names.
const EXCHANGE_CODE = /^[A-Z0-9]{1,6}$/;

const CONVERTIBLE_CURRENCIES = new Set<string>(['SGD', 'MYR', 'USD']);

// Yahoo answers requests without a User-Agent with 429 Too Many Requests.
const REQUEST_HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; PlutusAI/1.0)' };

export function toYahooSymbol(symbol: string, assetClass: AssetClass): string | null {
  const normalized = symbol.trim().toUpperCase();
  if (assetClass === 'stocks_us') {
    return normalized;
  }

  const override = resolveYahooSymbol(normalized);
  if (override) {
    return override;
  }

  const suffix = YAHOO_SUFFIX[assetClass];
  if (!suffix) {
    return null;
  }
  if (normalized.endsWith(suffix)) {
    return normalized;
  }
  return EXCHANGE_CODE.test(normalized) ? `${normalized}${suffix}` : null;
}

export async function getStockPrice(
  symbol: string,
  assetClass: AssetClass,
  currency: Currency,
): Promise<PriceQuote | null> {
  const yahooSymbol = toYahooSymbol(symbol, assetClass);
  if (!yahooSymbol) {
    return null;
  }

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}`;

  try {
    const response = await fetch(url, { headers: REQUEST_HEADERS });
    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as {
      chart?: {
        result?: Array<{ meta?: { regularMarketPrice?: number; chartPreviousClose?: number; currency?: string } }>;
      };
    };
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta || typeof meta.regularMarketPrice !== 'number' || typeof meta.chartPreviousClose !== 'number') {
      return null;
    }

    // Value the position in the currency Yahoo actually quotes it in — a
    // statement can report an SGX stock's converted USD value, but its price
    // is in SGD. A currency with no exchange rate here can't be valued at all.
    if (typeof meta.currency === 'string' && !CONVERTIBLE_CURRENCIES.has(meta.currency)) {
      return null;
    }
    const quoteCurrency = (meta.currency as Currency | undefined) ?? currency;

    const previousClose = meta.chartPreviousClose;
    const changePct = previousClose > 0 ? ((meta.regularMarketPrice - previousClose) / previousClose) * 100 : 0;

    return {
      price: meta.regularMarketPrice,
      currency: quoteCurrency,
      change_pct: changePct,
      as_of: new Date(),
    };
  } catch {
    return null;
  }
}
