/**
 * /month command handler — this month's spend by category, then income and
 * the savings rate once any income is logged.
 */

import { getSpendingSummary } from '../../expense';
import { getIncomeTotal } from '../../income';
import { startOfMonth } from '../../utils/dates';
import { formatSavings, formatSpendingSummary } from '../formatter/messages';

export async function handleMonthCommand(userId: string, now: Date = new Date()): Promise<string> {
  const [summary, incomeSgd] = await Promise.all([
    getSpendingSummary(userId, 'month', now),
    getIncomeTotal(userId, startOfMonth(now), startOfMonth(now, 1)),
  ]);
  return [formatSpendingSummary('This month’s spend', summary), formatSavings(incomeSgd, summary.total)]
    .filter(Boolean)
    .join('\n\n');
}
