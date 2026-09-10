/**
 * /today command handler
 */

import { getSpendingSummary } from '../../expense';
import { formatSpendingSummary } from '../formatter/messages';

export async function handleTodayCommand(userId: string): Promise<string> {
  const summary = await getSpendingSummary(userId, 'today');
  return formatSpendingSummary('Today’s spend', summary);
}
