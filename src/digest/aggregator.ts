/**
 * Collects digest data from the expense and budget modules. Each source is
 * isolated — one failing source degrades to a SectionResult error and never
 * blocks or fails the others.
 */

import { getSpendingSummary, getRecurringFiredToday } from '../expense';
import { getBudgetStatus } from '../budget';
import { getPortfolioSummary } from '../portfolio';
import { generatePortfolioAdvice } from '../portfolio/advice';
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

/**
 * Prices the user's portfolio, then asks their own provider what today's
 * market news means for it. Kept as one settle()'d unit so a price-fetch
 * failure and an advice failure both degrade this section alone.
 */
async function collectPortfolioAdvice(userId: string): Promise<string> {
  const summary = await getPortfolioSummary(userId);
  return generatePortfolioAdvice(userId, summary);
}

export async function collectDigestData(userId: string): Promise<DigestData> {
  const [spending, recurringFired, budgetStatuses, portfolio] = await Promise.all([
    settle('spending', getSpendingSummary(userId, 'today')),
    settle('recurringFired', getRecurringFiredToday(userId)),
    settle('budgetStatuses', getBudgetStatus(userId)),
    settle('portfolio', collectPortfolioAdvice(userId)),
  ]);

  return {
    spending,
    recurringFired,
    budgetStatuses,
    portfolio,
  };
}
