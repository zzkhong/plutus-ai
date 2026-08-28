/**
 * Digest module types
 */

import { BudgetStatus } from '../budget';
import { SpendingSummary } from '../expense';
import { Transaction } from '../types';

export type SectionResult<T> = T | { error: string };

export interface DigestData {
  spending: SectionResult<SpendingSummary>;
  recurringFired: SectionResult<Transaction[]>;
  budgetStatuses: SectionResult<BudgetStatus[]>;
  portfolio: { error: string };
}
