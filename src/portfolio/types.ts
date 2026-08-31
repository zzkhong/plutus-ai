/**
 * Portfolio module types
 */

import { AssetClass, Currency } from '../types';

export type Broker = 'ibkr' | 'moomoo';

export interface Holding {
  id: string;
  symbol: string;
  name: string;
  asset_class: AssetClass;
  quantity: number;
  currency: Currency;
  market: string;
  broker: Broker | null; // null = manually entered (crypto/cash)
  cost_basis?: number;
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
}

export interface ParsedStatement {
  broker: Broker;
  holdings: ParsedHolding[];
}

export interface PriceQuote {
  price: number; // in quote currency, not cents
  currency: Currency;
  change_pct: number; // vs previous close / 24h
  as_of: Date;
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
