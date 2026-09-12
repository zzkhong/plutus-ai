/**
 * Budget types shared outside the budget module
 */

import { Category } from './transaction';

/** The budget over all spending, rather than one category. */
export const OVERALL_BUDGET = 'Overall';

/** What a budget covers: one spending category, or all spending. */
export type BudgetCategory = Category | typeof OVERALL_BUDGET;
