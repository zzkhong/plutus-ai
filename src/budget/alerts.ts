/**
 * Budget alert detection. Pure w.r.t. delivery — returns alert data,
 * does not know about Telegram. See src/scheduler/recurring.ts for delivery.
 */

import { randomUUID } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { budget_alerts } from '../db/schema';
import { Transaction } from '../types';
import { getSpendingByCategory } from '../expense/service';
import { findBudgetByCategory } from './service';
import { Alert } from './types';

function currentMonthKey(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

async function markAlertSent(budgetId: string, threshold: 80 | 100, month: string): Promise<boolean> {
  const existing = await db
    .select()
    .from(budget_alerts)
    .where(
      and(
        eq(budget_alerts.budget_id, budgetId),
        eq(budget_alerts.threshold, threshold),
        eq(budget_alerts.month, month),
      ),
    );

  if (existing.length > 0) {
    return false;
  }

  await db.insert(budget_alerts).values({
    id: randomUUID(),
    budget_id: budgetId,
    threshold,
    month,
    sent_at: Date.now(),
  });

  return true;
}

function formatAlertMessage(category: string, threshold: 80 | 100, spentSgd: number, budgetSgd: number): string {
  const spent = (spentSgd / 100).toFixed(2);
  const limit = (budgetSgd / 100).toFixed(2);
  const icon = threshold === 100 ? '🚨' : '⚠️';
  const verb = threshold === 100 ? 'hit' : 'used';
  return `${icon} ${category} budget alert: you've ${verb} ${threshold}% (S$${spent} / S$${limit}) this month.`;
}

export async function checkAlerts(transaction: Transaction): Promise<Alert | null> {
  const budget = await findBudgetByCategory(transaction.category);
  if (!budget || budget.amount_sgd <= 0) {
    return null;
  }

  const spending = await getSpendingByCategory('month');
  const spentSgd = spending.find((entry) => entry.category === transaction.category)?.total ?? 0;
  const percentage = (spentSgd / budget.amount_sgd) * 100;
  const month = currentMonthKey();

  if (percentage >= 100) {
    const fired = await markAlertSent(budget.id, 100, month);
    await markAlertSent(budget.id, 80, month);
    if (!fired) {
      return null;
    }
    return {
      budget_id: budget.id,
      category: budget.category,
      threshold: 100,
      message: formatAlertMessage(budget.category, 100, spentSgd, budget.amount_sgd),
    };
  }

  if (percentage >= 80) {
    const fired = await markAlertSent(budget.id, 80, month);
    if (!fired) {
      return null;
    }
    return {
      budget_id: budget.id,
      category: budget.category,
      threshold: 80,
      message: formatAlertMessage(budget.category, 80, spentSgd, budget.amount_sgd),
    };
  }

  return null;
}
