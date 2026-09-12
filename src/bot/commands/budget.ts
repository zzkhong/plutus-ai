/**
 * /budget command handler
 */

import { getBudgetStatus } from '../../budget';
import { formatBudgetStatus } from '../formatter/messages';

export async function handleBudgetCommand(userId: string): Promise<string> {
  return formatBudgetStatus(await getBudgetStatus(userId));
}
