/**
 * Budget progress calculator — current month spend vs each budget, and where
 * the month is heading at its pace so far.
 */

import { getSpendingSummary } from '../expense/service';
import { SpendingSummary } from '../expense/types';
import { BudgetCategory, OVERALL_BUDGET } from '../types';
import { daysInMonth } from '../utils/dates';
import { listBudgets } from './service';
import { BudgetStatus } from './types';

/**
 * Pace projections start on the 7th. Earlier than that, one big grocery run
 * or a monthly bill reads as a disastrous month.
 */
export const PACE_MIN_DAY = 7;

/** Month-end spend if the rest of the month goes like it has so far; undefined before PACE_MIN_DAY. */
export function projectMonthEnd(spentSgd: number, now: Date): number | undefined {
  const day = now.getDate();
  if (day < PACE_MIN_DAY) {
    return undefined;
  }
  return Math.round((spentSgd / day) * daysInMonth(now));
}

/** What counts against a budget: its category's spend, or everything for the overall budget. */
export function spentAgainst(category: BudgetCategory, summary: SpendingSummary): number {
  return category === OVERALL_BUDGET ? summary.total : (summary.byCategory[category] ?? 0);
}

/** `now` is injectable for tests. */
export async function getBudgetStatus(userId: string, now: Date = new Date()): Promise<BudgetStatus[]> {
  const [budgetsList, summary] = await Promise.all([listBudgets(userId), getSpendingSummary(userId, 'month', now)]);
  const daysLeft = daysInMonth(now) - now.getDate();

  return budgetsList.map((budget) => {
    const spentSgd = spentAgainst(budget.category, summary);
    const percentage =
      budget.amount_sgd > 0 ? Math.round((spentSgd / budget.amount_sgd) * 1000) / 10 : 0;

    return {
      category: budget.category,
      budget_amount: budget.amount,
      budget_currency: budget.currency,
      budget_sgd: budget.amount_sgd,
      spent_sgd: spentSgd,
      percentage,
      remaining_sgd: budget.amount_sgd - spentSgd,
      days_left_in_month: daysLeft,
      projected_sgd: projectMonthEnd(spentSgd, now),
    };
  });
}
