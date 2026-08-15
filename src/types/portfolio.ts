/**
 * Portfolio and holding types
 */

import { Currency } from './transaction';

export type AssetClass = 'stocks_us' | 'stocks_my' | 'crypto' | 'cash';

export interface Holding {
  id: string;
  symbol: string; // e.g., "AAPL", "BTC"
  name: string; // e.g., "Apple Inc.", "Bitcoin"
  asset_class: AssetClass;
  quantity: number; // Real number, not cents
  currency: Currency;
  market: string; // e.g., "NASDAQ", "Binance"
  cost_basis?: number; // Optional, in cents
  created_at: Date;
  updated_at: Date;
}

export interface Portfolio {
  total_value_sgd: number; // Total portfolio value in SGD cents
  holdings: Holding[];
  updated_at: Date;
}
