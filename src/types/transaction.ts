/**
 * Transaction types and related enums
 */

// ISO 4217. Crypto is an asset priced in USD, not a currency.
export type Currency = 'SGD' | 'MYR' | 'USD';

export type Category =
  | 'Food'
  | 'Transport'
  | 'Shopping'
  | 'Entertainment'
  | 'Bills'
  | 'Health'
  | 'Education'
  | 'Travel'
  | 'Groceries'
  | 'Others';

export interface Transaction {
  id: string;
  amount: number; // in cents
  currency: Currency;
  amount_sgd: number; // normalized to SGD in cents
  merchant: string;
  category: Category;
  source: string; // how it was logged: text, voice, receipt, apple_pay, split, recurring
  card_name: string; // e.g., "OCBC iPhone"
  note?: string;
  spent_at: Date; // when the money was spent; totals and budgets go by this
  created_at: Date; // when it was logged; "latest" goes by this
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

export interface Income {
  id: string;
  amount: number; // in cents
  currency: Currency;
  amount_sgd: number; // normalized to SGD in cents
  source: string; // what it was, e.g. "Salary"
  note?: string;
  received_at: Date;
  created_at: Date;
}
