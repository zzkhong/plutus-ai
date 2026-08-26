/**
 * Budget progress calculator — current month spend vs each budget.
 */

import { getSpendingByCategory } from '../expense/service';
import { listBudgets } from './service';
import { BudgetStatus } from './types';

function daysLeftInMonth(now: Date): number {
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  return daysInMonth - now.getDate();
}

export async function getBudgetStatus(): Promise<BudgetStatus[]> {
  const [budgets, spending] = await Promise.all([listBudgets(), getSpendingByCategory('month')]);
  const spendByCategory = new Map(spending.map((entry) => [entry.category, entry.total]));
  const daysLeft = daysLeftInMonth(new Date());

  return budgets.map((budget) => {
    const spentSgd = spendByCategory.get(budget.category) ?? 0;
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
    };
  });
}
