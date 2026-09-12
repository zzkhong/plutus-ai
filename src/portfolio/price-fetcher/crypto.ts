/**
 * Crypto prices via CoinGecko's free API, for the coins in COINGECKO_IDS.
 *
 * CoinGecko keys coins by id, not ticker, and many tickers are shared by
 * unrelated tokens — so an unlisted symbol degrades to "price unavailable"
 * rather than being looked up by name and risking a wrong price. To support
 * another coin, add its id from the coin's CoinGecko page.
 */

import { Currency } from '../../types';
import { PriceQuote } from '../types';

export const COINGECKO_IDS: Record<string, string> = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  // Binance's Beacon ETH, and the wrapped token that replaced it.
  BETH: 'binance-eth',
  WBETH: 'wrapped-beacon-eth',
  SOL: 'solana',
  BNB: 'binancecoin',
  XRP: 'ripple',
  ADA: 'cardano',
  DOGE: 'dogecoin',
  USDT: 'tether',
  USDC: 'usd-coin',
  AVAX: 'avalanche-2',
  DOT: 'polkadot',
  LINK: 'chainlink',
  TON: 'the-open-network',
  TRX: 'tron',
  LTC: 'litecoin',
  SHIB: 'shiba-inu',
  BCH: 'bitcoin-cash',
  NEAR: 'near',
  UNI: 'uniswap',
  XLM: 'stellar',
  SUI: 'sui',
  APT: 'aptos',
  POL: 'polygon-ecosystem-token',
  MATIC: 'matic-network',
  ARB: 'arbitrum',
  OP: 'optimism',
  ICP: 'internet-computer',
  HBAR: 'hedera-hashgraph',
  ATOM: 'cosmos',
  PEPE: 'pepe',
};

function coingeckoId(symbol: string): string | undefined {
  const key = symbol.trim().toUpperCase();
  return Object.prototype.hasOwnProperty.call(COINGECKO_IDS, key) ? COINGECKO_IDS[key] : undefined;
}

/** Whether a coin has a price source — used to warn when one is added that doesn't. */
export function isPricedCrypto(symbol: string): boolean {
  return coingeckoId(symbol) !== undefined;
}

export async function getCryptoPrice(symbol: string): Promise<PriceQuote | null> {
  const id = coingeckoId(symbol);
  if (!id) {
    return null;
  }

  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd&include_24hr_change=true`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as Record<string, { usd?: number; usd_24h_change?: number }>;
    const entry = data[id];
    if (!entry || typeof entry.usd !== 'number') {
      return null;
    }

    return {
      price: entry.usd,
      currency: 'USD' as Currency,
      change_pct: typeof entry.usd_24h_change === 'number' ? entry.usd_24h_change : 0,
      as_of: new Date(),
      source: 'market',
    };
  } catch {
    return null;
  }
}
