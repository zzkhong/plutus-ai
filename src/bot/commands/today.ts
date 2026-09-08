/**
 * /today command handler
 */

import { getSpendingSummary } from '../../expense';
import { formatSpendingSummary } from '../formatter/messages';

export async function handleTodayCommand(): Promise<string> {
  const summary = await getSpendingSummary('today');
  return formatSpendingSummary('Today’s spend', summary);
}
