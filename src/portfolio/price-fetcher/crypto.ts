/**
 * Crypto price fetching via CoinGecko's free API.
 */

import { Currency } from '../../types';
import { PriceQuote } from '../types';

const COINGECKO_IDS: Record<'BTC' | 'ETH' | 'BETH', string> = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  BETH: 'binance-staked-eth',
};

export async function getCryptoPrice(symbol: 'BTC' | 'ETH' | 'BETH'): Promise<PriceQuote | null> {
  const id = COINGECKO_IDS[symbol];
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd&include_24hr_change=true`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    const entry = data[id];
    if (!entry || typeof entry.usd !== 'number') {
      return null;
    }

    return {
      price: entry.usd,
      currency: 'USD' as Currency,
      change_pct: typeof entry.usd_24h_change === 'number' ? entry.usd_24h_change : 0,
      as_of: new Date(),
    };
  } catch {
    return null;
  }
}
