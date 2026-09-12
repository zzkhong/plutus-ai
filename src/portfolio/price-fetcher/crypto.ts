/**
 * Crypto prices via CoinGecko's free API.
 *
 * CoinGecko keys coins by id, not ticker, and many tickers are shared by
 * unrelated tokens, so a ticker alone is never looked up and priced. A coin
 * is priced by its id: from COINGECKO_IDS for the common ones, or, for any
 * other coin, the id the user picked from searchCoins' exact-ticker matches
 * (stored as holdings.coingecko_id).
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

/** `id` is the coin's CoinGecko id — by default, the built-in table's for `symbol`. */
export async function getCryptoPrice(
  symbol: string,
  id: string | undefined = coingeckoId(symbol),
): Promise<PriceQuote | null> {
  if (!id) {
    return null;
  }

  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=usd&include_24hr_change=true`;

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

export interface CoinCandidate {
  id: string; // CoinGecko id
  name: string;
  symbol: string;
  rank: number; // CoinGecko market-cap rank, 1 = largest
}

const SEARCH_TIMEOUT_MS = 10_000;

interface SearchCoin {
  id: string;
  name: string;
  symbol: string;
  market_cap_rank: number;
}

/**
 * Coins on CoinGecko whose ticker is exactly `symbol`, largest first. Only
 * coins with a market-cap rank are offered: an unranked token wearing a
 * popular ticker is usually a copy, and choosing it would price the holding
 * at a stranger's token. Never throws — a failed search is an empty list.
 */
export async function searchCoins(symbol: string, limit = 3): Promise<CoinCandidate[]> {
  const ticker = symbol.trim().toUpperCase();
  if (!ticker) {
    return [];
  }

  try {
    const response = await fetch(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(ticker)}`, {
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      return [];
    }
    const data = (await response.json()) as { coins?: Array<Partial<Record<keyof SearchCoin, unknown>>> };
    return (data.coins ?? [])
      .filter(
        (coin): coin is SearchCoin =>
          typeof coin.id === 'string' &&
          typeof coin.name === 'string' &&
          typeof coin.symbol === 'string' &&
          coin.symbol.toUpperCase() === ticker &&
          typeof coin.market_cap_rank === 'number',
      )
      .sort((a, b) => a.market_cap_rank - b.market_cap_rank)
      .slice(0, limit)
      .map((coin) => ({ id: coin.id, name: coin.name, symbol: ticker, rank: coin.market_cap_rank }));
  } catch {
    return [];
  }
}

/**
 * The coin searchCoins offers for `symbol` at market-cap rank `rank`, or null.
 * The coin picker's buttons carry the rank rather than the id, which can be
 * too long for Telegram's 64-byte callback data.
 */
export async function findCoinByRank(symbol: string, rank: number): Promise<CoinCandidate | null> {
  return (await searchCoins(symbol, Number.MAX_SAFE_INTEGER)).find((coin) => coin.rank === rank) ?? null;
}
