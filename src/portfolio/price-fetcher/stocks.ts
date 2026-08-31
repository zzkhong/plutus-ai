/**
 * US/MY/SG stock price fetching via Yahoo Finance's unofficial chart API.
 * MY (.KL) and SG (.SI) symbols are resolved through a manual mapping table
 * since broker statements report them differently than Yahoo does.
 */

import { AssetClass, Currency } from '../../types';
import { PriceQuote } from '../types';
import { resolveYahooSymbol } from './symbol-map';

function toYahooSymbol(symbol: string, assetClass: AssetClass): string | null {
  if (assetClass === 'stocks_us') {
    return symbol;
  }
  return resolveYahooSymbol(symbol);
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
    const response = await fetch(url);
    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta || typeof meta.regularMarketPrice !== 'number' || typeof meta.chartPreviousClose !== 'number') {
      return null;
    }

    const changePct = ((meta.regularMarketPrice - meta.chartPreviousClose) / meta.chartPreviousClose) * 100;

    return {
      price: meta.regularMarketPrice,
      currency,
      change_pct: changePct,
      as_of: new Date(),
    };
  } catch {
    return null;
  }
}
