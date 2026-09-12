/**
 * Expense engine types
 */

import { Category, Currency, Transaction } from '../types';

export type ExpenseSource = 'apple_pay' | 'text' | 'voice' | 'split' | 'receipt';
export type SpendingPeriod = 'today' | 'week' | 'month';

export interface ExpenseInput {
  amount: number;
  currency?: Currency;
  merchant?: string;
  cardName?: string;
  note?: string;
  source: ExpenseSource | string;
  /**
   * A category already worked out upstream — the chat classifier's or the
   * receipt reader's. Used when the user has no history with the merchant,
   * and saves a separate categorization call.
   */
  categoryHint?: Category;
  /** When the money was spent, if not now ("yesterday", a receipt's date). */
  spentAt?: Date;
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

/** One way a transaction can be corrected, with the value as the user gave it. */
export type CorrectionField = 'amount' | 'currency' | 'merchant' | 'category' | 'note' | 'date';
