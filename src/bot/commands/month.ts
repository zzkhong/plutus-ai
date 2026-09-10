/**
 * /month command handler
 */

import { getSpendingSummary } from '../../expense';
import { formatSpendingSummary } from '../formatter/messages';

export async function handleMonthCommand(userId: string): Promise<string> {
  const summary = await getSpendingSummary(userId, 'month');
  return formatSpendingSummary('This month’s spend', summary);
}
