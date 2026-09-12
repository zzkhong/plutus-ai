/**
 * Budget alert detection. Pure w.r.t. delivery — returns alert data, does
 * not know about Telegram. Callers put the message in the expense's reply
 * (budgetAlertFor), or push it (src/scheduler/recurring.ts).
 *
 * Three alerts per budget per month, each sent at most once: 80% used, 100%
 * used, and — before either — a pace warning when the month so far points
 * well past the budget.
 */

import { randomUUID } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { budget_alerts } from '../db/schema';
import { getSpendingSummary } from '../expense/service';
import { formatCurrency } from '../config/currencies';
import { OVERALL_BUDGET, Transaction } from '../types';
import { daysInMonth, monthKey } from '../utils/dates';
import { logger } from '../utils/logger';
import { projectMonthEnd, spentAgainst } from './progress';
import { findBudgetByCategory } from './service';
import { Alert, Budget } from './types';

/** How the pace warning is stored in budget_alerts.threshold. */
export const PACE_THRESHOLD = 0;

/** A pace warning needs the month heading at least 10% over — not just brushing the line. */
const PACE_MARGIN = 1.1;

function sgd(cents: number): string {
  return formatCurrency(cents, 'SGD');
}

/** Records that an alert went out; false if it already had this month. */
async function markAlertSent(userId: string, budgetId: string, threshold: number, month: string): Promise<boolean> {
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
    user_id: userId,
    budget_id: budgetId,
    threshold,
    month,
    sent_at: Date.now(),
  });

  return true;
}

function formatAlertMessage(category: string, threshold: 80 | 100, spentSgd: number, budgetSgd: number): string {
  const icon = threshold === 100 ? '🚨' : '⚠️';
  const verb = threshold === 100 ? 'hit' : 'used';
  return `${icon} ${category} budget alert: you've ${verb} ${threshold}% (${sgd(spentSgd)} / ${sgd(budgetSgd)}) this month.`;
}

function formatPaceMessage(category: string, spentSgd: number, projectedSgd: number, budgetSgd: number, now: Date): string {
  const daysLeft = daysInMonth(now) - now.getDate();
  return (
    `📈 ${category} budget: at this pace you'll spend about ${sgd(projectedSgd)} of your ${sgd(budgetSgd)} this month ` +
    `(${sgd(spentSgd)} so far, ${daysLeft} day${daysLeft === 1 ? '' : 's'} left).`
  );
}

async function evaluateBudget(userId: string, budget: Budget, spentSgd: number, now: Date): Promise<Alert | null> {
  const percentage = (spentSgd / budget.amount_sgd) * 100;
  const month = monthKey(now);
  const alert = (threshold: Alert['threshold'], message: string): Alert => ({
    budget_id: budget.id,
    category: budget.category,
    threshold,
    message,
  });

  if (percentage >= 100) {
    const fired = await markAlertSent(userId, budget.id, 100, month);
    await markAlertSent(userId, budget.id, 80, month);
    return fired ? alert(100, formatAlertMessage(budget.category, 100, spentSgd, budget.amount_sgd)) : null;
  }

  if (percentage >= 80) {
    const fired = await markAlertSent(userId, budget.id, 80, month);
    return fired ? alert(80, formatAlertMessage(budget.category, 80, spentSgd, budget.amount_sgd)) : null;
  }

  const projected = projectMonthEnd(spentSgd, now);
  if (projected !== undefined && projected > budget.amount_sgd * PACE_MARGIN) {
    const fired = await markAlertSent(userId, budget.id, PACE_THRESHOLD, month);
    return fired ? alert('pace', formatPaceMessage(budget.category, spentSgd, projected, budget.amount_sgd, now)) : null;
  }

  return null;
}

/**
 * The alerts a transaction newly triggers — for its category's budget, then
 * the overall budget. An expense dated in another month triggers none: its
 * spend doesn't count toward this month's budgets. `now` is injectable for
 * tests.
 */
export async function checkAlerts(userId: string, transaction: Transaction, now: Date = new Date()): Promise<Alert[]> {
  if (monthKey(transaction.spent_at) !== monthKey(now)) {
    return [];
  }

  const budgets = (
    await Promise.all([
      findBudgetByCategory(userId, transaction.category),
      findBudgetByCategory(userId, OVERALL_BUDGET),
    ])
  ).filter((budget): budget is Budget => budget !== null && budget.amount_sgd > 0);
  if (budgets.length === 0) {
    return [];
  }

  const summary = await getSpendingSummary(userId, 'month', now);
  const alerts: Alert[] = [];
  for (const budget of budgets) {
    const alert = await evaluateBudget(userId, budget, spentAgainst(budget.category, summary), now);
    if (alert) {
      alerts.push(alert);
    }
  }
  return alerts;
}

/**
 * The alert text a freshly logged or changed expense triggers, if any, for
 * callers that report the expense to the user — the chat and voice reply,
 * Apple Pay, a receipt, a /split share, a correction. Never throws: the
 * expense is already saved, and a failed alert check must not turn that into
 * an error the user retries, logging the expense twice.
 */
export async function budgetAlertFor(userId: string, transaction: Transaction): Promise<string | null> {
  try {
    const alerts = await checkAlerts(userId, transaction);
    return alerts.length > 0 ? alerts.map((alert) => alert.message).join('\n') : null;
  } catch (error) {
    logger.error('Budget alert check failed', error);
    return null;
  }
}
