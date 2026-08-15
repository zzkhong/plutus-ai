/**
 * Budget and spending types
 */

import { Category, Currency } from './transaction';

export type BudgetPeriod = 'daily' | 'weekly' | 'monthly' | 'yearly';

export interface Budget {
  id: string;
  category: Category;
  amount: number; // in cents
  currency: Currency;
  amount_sgd: number; // normalized to SGD in cents
  period: BudgetPeriod;
  created_at: Date;
  updated_at?: Date;
}

export interface BudgetSummary {
  category: Category;
  budget_amount: number; // in cents
  spent_amount: number; // in cents
  remaining: number; // in cents
  utilization_percentage: number;
  period: BudgetPeriod;
}
