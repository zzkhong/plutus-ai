/**
 * Expense engine types
 */

import { Category, Currency, Transaction } from '../types';

export type ExpenseSource = 'apple_pay' | 'text' | 'voice';
export type SpendingPeriod = 'today' | 'week' | 'month';

export interface ExpenseInput {
  amount: number;
  currency?: Currency;
  merchant?: string;
  cardName?: string;
  note?: string;
  source: ExpenseSource | string;
}

export interface RecurringInput {
  amount: number;
  currency?: Currency;
  merchant: string;
  category?: Category;
  day_of_month: number;
  is_active?: boolean;
}

export interface SpendingSummary {
  period: SpendingPeriod;
  total: number;
  count: number;
  byCategory: Record<string, number>;
  byCategoryCount: Record<string, number>;
  topExpenses: Transaction[];
}

export interface Comparison {
  period1: SpendingSummary;
  period2: SpendingSummary;
  delta: number;
}
