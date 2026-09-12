/**
 * Shared message formatting helpers for Telegram responses
 */

import type { SpendingSummary } from '../../expense/types';
import type { BudgetStatus } from '../../budget/types';
import { formatCurrency } from '../../config/currencies';
import { Currency } from '../../types';

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

function budgetStanding(status: BudgetStatus): string {
  return status.remaining_sgd >= 0 ? `${sgd(status.remaining_sgd)} left` : `over by ${sgd(-status.remaining_sgd)}`;
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
  return `${spend}\nThat's ${budget.percentage}% of your ${sgd(budget.budget_sgd)} budget, ${budgetStanding(budget)}.`;
}

export function formatBudgetStatus(statuses: BudgetStatus[]): string {
  if (statuses.length === 0) {
    return 'No budgets set yet. Try "Set food budget to $800/month" to create one.';
  }

  const daysLeft = statuses[0].days_left_in_month;
  const lines = statuses.map(
    (status) =>
      `${status.category}: ${sgd(status.spent_sgd)} of ${sgd(status.budget_sgd)} (${status.percentage}%), ${budgetStanding(status)}`,
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
    '/month - this month\'s spend by category',
    '/budget - how each budget is doing this month',
    '/undo - undo your last transaction',
    '/export - this year\'s transactions as a CSV file',
    '/portfolio - net worth and holdings',
    '/split - split a bill from a receipt photo',
    '/cancel - cancel an in-progress split',
    '/digest - preview tonight\'s digest',
    '/webhookkey - your iOS Shortcut webhook key',
    '/help - this menu',
    '',
    'Or just message me naturally:',
    '“Spent $4.50 at Ya Kun” · “RM 45 at Kopitiam”',
    '“How much did I spend on food this month?”',
    '“Set food budget to $500” · “Actually that was $12”',
  ]);
}

export function formatUserFriendlyError(): string {
  return 'Oops — something hiccupped. Try again or use /help if you want a quick reset.';
}
