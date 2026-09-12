/**
 * Budget module types
 */

import { BudgetCategory, Currency } from '../types';

export interface Budget {
  id: string;
  category: BudgetCategory;
  amount: number; // cents, in original currency
  currency: Currency;
  amount_sgd: number; // cents, normalized to SGD
  created_at: Date;
  updated_at: Date;
}

export interface BudgetStatus {
  category: BudgetCategory;
  budget_amount: number; // cents, original currency
  budget_currency: Currency;
  budget_sgd: number; // cents
  spent_sgd: number; // cents
  percentage: number; // spent_sgd / budget_sgd * 100, one decimal place
  remaining_sgd: number; // cents, can be negative when over budget
  days_left_in_month: number;
  /** Month-end spend at the pace so far, in cents; absent early in the month. */
  projected_sgd?: number;
}

/** 80% and 100% of the budget, or a warning that the month's pace will overshoot it. */
export type AlertThreshold = 80 | 100 | 'pace';

export interface Alert {
  budget_id: string;
  category: BudgetCategory;
  threshold: AlertThreshold;
  message: string;
}
