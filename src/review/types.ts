/**
 * Month-end review types
 */

import { BudgetCategory } from '../types';

export interface CategoryChange {
  category: string;
  spentSgd: number; // cents, the reviewed month
  previousSgd: number; // cents, the month before
}

export interface MerchantTotal {
  merchant: string;
  spentSgd: number; // cents
  count: number;
}

export interface BudgetOutcome {
  category: BudgetCategory;
  budgetSgd: number; // cents
  spentSgd: number; // cents
}

export interface MonthReviewData {
  month: Date; // the 1st of the reviewed month
  previousMonth: Date; // the 1st of the month before
  spentSgd: number;
  count: number;
  previousSpentSgd: number;
  categories: CategoryChange[]; // largest first
  merchants: MerchantTotal[]; // largest first
  incomeSgd: number;
  budgets: BudgetOutcome[];
}
