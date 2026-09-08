/**
 * /month command handler
 */

import { getSpendingSummary } from '../../expense';
import { formatSpendingSummary } from '../formatter/messages';

export async function handleMonthCommand(): Promise<string> {
  const summary = await getSpendingSummary('month');
  return formatSpendingSummary('This month’s spend', summary);
}
