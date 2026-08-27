/**
 * Budget module types
 */

import { Category, Currency } from '../types';

export interface Budget {
  id: string;
  category: Category;
  amount: number; // cents, in original currency
  currency: Currency;
  amount_sgd: number; // cents, normalized to SGD
  created_at: Date;
  updated_at: Date;
}

export interface BudgetStatus {
  category: Category;
  budget_amount: number; // cents, original currency
  budget_currency: Currency;
  budget_sgd: number; // cents
  spent_sgd: number; // cents
  percentage: number; // spent_sgd / budget_sgd * 100, one decimal place
  remaining_sgd: number; // cents, can be negative when over budget
  days_left_in_month: number;
}

export interface Alert {
  budget_id: string;
  category: Category;
  threshold: 80 | 100;
  message: string;
}
