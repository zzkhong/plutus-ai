/**
 * Collects one month's review: spend against the month before, where it
 * went, income, and how each budget ended.
 */

import { listTransactionsBetween, summarizeTransactions } from '../expense/service';
import { listBudgets } from '../budget/service';
import { spentAgainst } from '../budget/progress';
import { getIncomeTotal } from '../income/service';
import { Transaction } from '../types';
import { startOfMonth } from '../utils/dates';
import { MerchantTotal, MonthReviewData } from './types';

const TOP_MERCHANTS = 3;

/** Largest merchants by spend, folding case ("Grab" and "GRAB" are one). */
function topMerchants(rows: Transaction[], limit: number): MerchantTotal[] {
  const byKey = new Map<string, MerchantTotal>();
  for (const row of rows) {
    const key = row.merchant.trim().toLowerCase();
    const entry = byKey.get(key) ?? { merchant: row.merchant, spentSgd: 0, count: 0 };
    entry.spentSgd += row.amount_sgd;
    entry.count += 1;
    byKey.set(key, entry);
  }
  return [...byKey.values()].sort((a, b) => b.spentSgd - a.spentSgd).slice(0, limit);
}

/** `month` is any moment in the month to review. */
export async function collectMonthReview(userId: string, month: Date): Promise<MonthReviewData> {
  const start = startOfMonth(month);
  const end = startOfMonth(month, 1);
  const previousStart = startOfMonth(month, -1);

  const [current, previous, incomeSgd, budgets] = await Promise.all([
    listTransactionsBetween(userId, start, end),
    listTransactionsBetween(userId, previousStart, start),
    getIncomeTotal(userId, start, end),
    listBudgets(userId),
  ]);

  const summary = summarizeTransactions('month', current);
  const previousSummary = summarizeTransactions('month', previous);

  return {
    month: start,
    previousMonth: previousStart,
    spentSgd: summary.total,
    count: summary.count,
    previousSpentSgd: previousSummary.total,
    categories: Object.entries(summary.byCategory)
      .sort((a, b) => b[1] - a[1])
      .map(([category, spentSgd]) => ({ category, spentSgd, previousSgd: previousSummary.byCategory[category] ?? 0 })),
    merchants: topMerchants(current, TOP_MERCHANTS),
    incomeSgd,
    // Budgets aren't versioned, so a month is judged against today's amounts.
    budgets: budgets
      .filter((budget) => budget.amount_sgd > 0)
      .map((budget) => ({
        category: budget.category,
        budgetSgd: budget.amount_sgd,
        spentSgd: spentAgainst(budget.category, summary),
      })),
  };
}
