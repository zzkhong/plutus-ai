/**
 * Transaction types and related enums
 */

export type Currency = 'SGD' | 'MYR' | 'USD' | 'BTC' | 'ETH' | 'BETH';

export type Category =
  | 'Food'
  | 'Transport'
  | 'Shopping'
  | 'Entertainment'
  | 'Healthcare'
  | 'Utilities'
  | 'Education'
  | 'Investment'
  | 'Savings'
  | 'Other';

export interface Transaction {
  id: string;
  amount: number; // in cents
  currency: Currency;
  amount_sgd: number; // normalized to SGD in cents
  merchant: string;
  category: Category;
  source: string; // e.g., "OCBC", "DBS"
  card_name: string; // e.g., "OCBC iPhone"
  note?: string;
  created_at: Date;
  updated_at?: Date;
}

export interface RecurringTransaction {
  id: string;
  amount: number; // in cents
  currency: Currency;
  merchant: string;
  category: Category;
  day_of_month: number;
  is_active: boolean;
  created_at: Date;
  updated_at?: Date;
}
