/**
 * Collects digest data from the expense and budget modules. Each source is
 * isolated — one failing source degrades to a SectionResult error and never
 * blocks or fails the others.
 */

import { getSpendingSummary, getRecurringFiredToday } from '../expense';
import { getBudgetStatus } from '../budget';
import { logger } from '../utils/logger';
import { DigestData, SectionResult } from './types';

export async function settle<T>(section: string, promise: Promise<T>): Promise<SectionResult<T>> {
  try {
    return await promise;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`Digest section "${section}" failed, degrading gracefully`, { error: message });
    return { error: message };
  }
}

export async function collectDigestData(): Promise<DigestData> {
  const [spending, recurringFired, budgetStatuses] = await Promise.all([
    settle('spending', getSpendingSummary('today')),
    settle('recurringFired', getRecurringFiredToday()),
    settle('budgetStatuses', getBudgetStatus()),
  ]);

  return {
    spending,
    recurringFired,
    budgetStatuses,
    portfolio: { error: 'not yet implemented' },
  };
}
