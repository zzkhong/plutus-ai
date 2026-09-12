/**
 * Portfolio module types
 */

import { AssetClass, Currency } from '../types';

/**
 * A statement source's normalized short name — "ibkr", "moomoo", or whatever
 * normalizeBroker makes of another broker's name. Importing a statement
 * replaces every holding with the same broker value.
 */
export type Broker = string;

export interface Holding {
  id: string;
  symbol: string;
  name: string;
  asset_class: AssetClass;
  quantity: number;
  currency: Currency;
  market: string;
  broker: Broker | null; // null = entered in chat (crypto/cash)
  cost_basis?: number;
  /** Per-unit price from the statement this was imported from, in `currency`. Null for holdings entered in chat. */
  price: number | null;
  /** The date that statement valued the position at. */
  price_as_of: Date | null;
  /** The CoinGecko coin the user picked for a crypto symbol outside the built-in table; null otherwise. */
  coingecko_id?: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface HoldingInput {
  symbol: string;
  name: string;
  quantity: number;
  asset_class: AssetClass;
  currency: Currency;
  market: string;
}

export interface ParsedHolding {
  symbol: string;
  name: string;
  quantity: number;
  asset_class: AssetClass; // 'stocks_us' | 'stocks_my' | 'stocks_sg'
  currency: Currency;
  market: string;
  /** Per-unit price on the statement date, in `currency`. */
  price?: number;
}

/** A position the statement lists that can't be valued here, and why. */
export interface SkippedPosition {
  symbol: string;
  reason: string;
}

export interface ParsedStatement {
  broker: Broker;
  /** The date the statement values its positions at. */
  as_of: Date;
  holdings: ParsedHolding[];
  skipped: SkippedPosition[];
}

export interface PriceQuote {
  price: number; // per unit, in `currency`, not cents
  currency: Currency;
  /** Move vs the previous close / 24h. Null for a statement price, which has no move. */
  change_pct: number | null;
  as_of: Date;
  source: 'statement' | 'market';
}

export interface EnrichedHolding extends Holding {
  quote: PriceQuote | null;
  value_sgd: number; // cents
}

export interface AllocationEntry {
  key: string; // asset class or currency value
  value_sgd: number;
  pct: number;
}

export interface PortfolioSummary {
  net_worth_sgd: number;
  by_class: AllocationEntry[];
  by_currency: AllocationEntry[];
  holdings: EnrichedHolding[];
}
