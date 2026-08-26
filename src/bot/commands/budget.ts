/**
 * /budget command handler
 */

import { getBudgetStatus } from '../../budget';

export async function handleBudgetCommand(): Promise<string> {
  const statuses = await getBudgetStatus();

  if (statuses.length === 0) {
    return 'No budgets set yet. Try "Set food budget to $800/month" to create one.';
  }

  const lines = statuses.map((status) => {
    const spent = (status.spent_sgd / 100).toFixed(2);
    const limit = (status.budget_sgd / 100).toFixed(2);
    return `${status.category}: S$${spent} / S$${limit} (${status.percentage}%) — ${status.days_left_in_month} day(s) left`;
  });

  return `Budget status:\n${lines.join('\n')}`;
}
