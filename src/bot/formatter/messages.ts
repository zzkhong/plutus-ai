/**
 * Shared message formatting helpers for Telegram responses. Pure — no I/O,
 * and nothing that reaches the database, so tests can import it statically.
 */

import type { SpendingSummary } from '../../expense/types';
import type { BudgetStatus } from '../../budget/types';
import { formatCurrency } from '../../config/currencies';
import { Currency, Transaction } from '../../types';
import { formatDay, isSameDay } from '../../utils/dates';

function sgd(cents: number): string {
  return formatCurrency(cents, 'SGD');
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** "S$4.50" for an SGD amount; "RM45.00 (S$14.02)" for anything else. */
export function formatMoneyWithSgd(value: { amount: number; currency: Currency; amount_sgd: number }): string {
  if (value.currency === 'SGD') {
    return sgd(value.amount_sgd);
  }
  return `${formatCurrency(value.amount, value.currency)} (${sgd(value.amount_sgd)})`;
}

/** "S$4.50 at Ya Kun under Food", plus the day when it wasn't today. */
export function formatExpenseLine(transaction: Transaction, now: Date = new Date()): string {
  const line = `${formatMoneyWithSgd(transaction)} at ${transaction.merchant} under ${transaction.category}`;
  return isSameDay(transaction.spent_at, now) ? line : `${line}, on ${formatDay(transaction.spent_at)}`;
}

/** One transaction opened from /recent. */
export function formatTransactionDetail(transaction: Transaction): string {
  return [
    `${formatMoneyWithSgd(transaction)} at ${transaction.merchant} — ${transaction.category}, ${formatDay(transaction.spent_at)}.`,
    'Change the category or delete it below. To fix the amount, merchant or date, reply to this message, e.g. "it was $12" or "that was yesterday".',
  ].join('\n\n');
}

function budgetStanding(status: BudgetStatus): string {
  return status.remaining_sgd >= 0 ? `${sgd(status.remaining_sgd)} left` : `over by ${sgd(-status.remaining_sgd)}`;
}

/** ", on pace for S$620.00" while still under a budget the month's pace will overshoot. */
function budgetPace(status: BudgetStatus): string {
  const heading = status.projected_sgd;
  return heading !== undefined && status.remaining_sgd >= 0 && heading > status.budget_sgd
    ? `, on pace for ${sgd(heading)}`
    : '';
}

export function formatSpendingSummary(label: string, summary: SpendingSummary): string {
  if (summary.count === 0) {
    return `${label}: ${sgd(0)}. Nothing logged yet.`;
  }

  const lines = [`${label}: ${sgd(summary.total)} across ${plural(summary.count, 'transaction')}.`];
  const byAmount = Object.entries(summary.byCategory).sort((a, b) => b[1] - a[1]);
  for (const [category, amount] of byAmount) {
    lines.push(`  ${category}: ${sgd(amount)} (${summary.byCategoryCount[category] ?? 0})`);
  }
  return lines.join('\n');
}

/**
 * "Income: S$5000.00 · saved S$1234.00 (24.7%)", or how far spending went
 * past income. Null with no income, since there's no rate to show.
 */
export function formatSavings(incomeSgd: number, spentSgd: number): string | null {
  if (incomeSgd <= 0) {
    return null;
  }
  const saved = incomeSgd - spentSgd;
  if (saved < 0) {
    return `Income: ${sgd(incomeSgd)} · spent ${sgd(-saved)} more than that.`;
  }
  const rate = Math.round((saved / incomeSgd) * 1000) / 10;
  return `Income: ${sgd(incomeSgd)} · saved ${sgd(saved)} (${rate}%).`;
}

/** A question about one category, with that category's budget when there is one. */
export function formatCategorySpend(
  label: string,
  category: string,
  totalSgd: number,
  count: number,
  budget?: BudgetStatus,
): string {
  const spend = `${label} on ${category}: ${sgd(totalSgd)} across ${plural(count, 'transaction')}.`;
  if (!budget) {
    return spend;
  }
  return `${spend}\nThat's ${budget.percentage}% of your ${sgd(budget.budget_sgd)} budget, ${budgetStanding(budget)}${budgetPace(budget)}.`;
}

export function formatBudgetStatus(statuses: BudgetStatus[]): string {
  if (statuses.length === 0) {
    return 'No budgets set yet. Try "Set food budget to $800/month", or "Monthly budget $3000" for all spending.';
  }

  const daysLeft = statuses[0].days_left_in_month;
  const lines = statuses.map(
    (status) =>
      `${status.category}: ${sgd(status.spent_sgd)} of ${sgd(status.budget_sgd)} (${status.percentage}%), ${budgetStanding(status)}${budgetPace(status)}`,
  );
  return [`Budgets this month (${plural(daysLeft, 'day')} left):`, ...lines].join('\n');
}

export function formatHeading(title: string): string {
  return `*${title}*`;
}

export function formatLines(title: string, lines: string[]): string {
  return [formatHeading(title), ...lines].join('\n');
}

export function formatHelpMessage(): string {
  return formatLines('Plutus commands', [
    '/setup - register, or rotate your LLM API key',
    '/today - today\'s spend',
    '/month - this month\'s spend by category, and your savings rate',
    '/budget - how each budget is doing this month',
    '/recent - your last 10 expenses, to fix or delete any of them',
    '/undo - undo your last transaction',
    '/review - last month in review',
    '/export - this year\'s transactions as a CSV file',
    '/portfolio - net worth and holdings',
    '/split - split a bill from a receipt photo',
    '/cancel - cancel an in-progress split',
    '/digest - preview tonight\'s digest',
    '/webhookkey - your iOS Shortcut webhook key',
    '/help - this menu',
    '',
    'Or just message me naturally:',
    '“Spent $4.50 at Ya Kun” · “Grab 18 yesterday”',
    '“Salary $5200 came in” · “Monthly budget $3000”',
    '“How much did I spend on food this month?”',
    '“Set food budget to $500” · “Actually that was $12”',
    'Send a photo of a receipt to log it.',
  ]);
}

export function formatUserFriendlyError(): string {
  return 'Oops — something hiccupped. Try again or use /help if you want a quick reset.';
}
