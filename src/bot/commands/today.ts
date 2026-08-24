/**
 * /today command handler
 */

import { getSpendingSummary } from '../../expense';

export async function handleTodayCommand(): Promise<string> {
  const summary = await getSpendingSummary('today');
  const total = (summary.total / 100).toFixed(2);
  const topCategories = Object.entries(summary.byCategory)
    .map(([category, amount]) => `${category}: ${(amount / 100).toFixed(2)}`)
    .join(', ') || 'none';

  return `Today’s spend: S$${total}.\nTransactions: ${summary.count}.\nBy category: ${topCategories}.`;
}
