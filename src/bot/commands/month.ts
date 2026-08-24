/**
 * /month command handler
 */

import { getSpendingSummary } from '../../expense';

export async function handleMonthCommand(): Promise<string> {
  const summary = await getSpendingSummary('month');
  const total = (summary.total / 100).toFixed(2);
  const topCategories = Object.entries(summary.byCategory)
    .map(([category, amount]) => `${category}: ${(amount / 100).toFixed(2)}`)
    .join(', ') || 'none';

  return `This month’s spend: S$${total}.\nTransactions: ${summary.count}.\nBy category: ${topCategories}.`;
}
