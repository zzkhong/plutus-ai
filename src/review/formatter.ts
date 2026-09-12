/**
 * Builds the month-end review message. Pure — no I/O.
 */

import { formatCurrency } from '../config/currencies';
import { formatSavings } from '../bot/formatter/messages';
import { formatMonth } from '../utils/dates';
import { MonthReviewData } from './types';

const TOP_CATEGORIES = 5;

function sgd(cents: number): string {
  return formatCurrency(cents, 'SGD');
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function monthName(date: Date): string {
  return date.toLocaleDateString('en-SG', { month: 'long' });
}

function percentChange(current: number, previous: number): number {
  return Math.round(((current - previous) / previous) * 100);
}

function headline(data: MonthReviewData): string {
  const spent = `Spent ${sgd(data.spentSgd)} across ${plural(data.count, 'expense')}`;
  if (data.previousSpentSgd <= 0) {
    return `${spent}.`;
  }
  const change = percentChange(data.spentSgd, data.previousSpentSgd);
  const previous = monthName(data.previousMonth);
  if (change === 0) {
    return `${spent}, about the same as ${previous}.`;
  }
  return `${spent}, ${Math.abs(change)}% ${change < 0 ? 'less' : 'more'} than ${previous} (${sgd(data.previousSpentSgd)}).`;
}

/** "(↑8%)", "(new)", or nothing when there's no earlier month to compare with. */
function categoryChange(spentSgd: number, previousSgd: number, hasPreviousMonth: boolean): string {
  if (!hasPreviousMonth) {
    return '';
  }
  if (previousSgd <= 0) {
    return ' (new)';
  }
  const change = percentChange(spentSgd, previousSgd);
  if (change === 0) {
    return ' (same)';
  }
  return ` (${change > 0 ? '↑' : '↓'}${Math.abs(change)}%)`;
}

export function formatMonthReview(data: MonthReviewData): string {
  const lines = [`📅 ${formatMonth(data.month)} in review`, '', headline(data)];

  const savings = formatSavings(data.incomeSgd, data.spentSgd);
  if (savings) {
    lines.push(savings);
  }

  if (data.categories.length > 0) {
    const hasPreviousMonth = data.previousSpentSgd > 0;
    lines.push('', 'Where it went:');
    for (const entry of data.categories.slice(0, TOP_CATEGORIES)) {
      lines.push(`  ${entry.category}: ${sgd(entry.spentSgd)}${categoryChange(entry.spentSgd, entry.previousSgd, hasPreviousMonth)}`);
    }
  }

  if (data.merchants.length > 0) {
    lines.push('', 'Top merchants:');
    for (const entry of data.merchants) {
      lines.push(`  ${entry.merchant}: ${sgd(entry.spentSgd)} (${plural(entry.count, 'time')})`);
    }
  }

  if (data.budgets.length > 0) {
    const kept = data.budgets.filter((budget) => budget.spentSgd <= budget.budgetSgd).length;
    lines.push('', `Budgets: kept ${kept} of ${data.budgets.length}.`);
    for (const budget of data.budgets) {
      const over = budget.spentSgd - budget.budgetSgd;
      lines.push(
        over > 0
          ? `  ❌ ${budget.category}: ${sgd(budget.spentSgd)} of ${sgd(budget.budgetSgd)}, over by ${sgd(over)}`
          : `  ✅ ${budget.category}: ${sgd(budget.spentSgd)} of ${sgd(budget.budgetSgd)}`,
      );
    }
  }

  return lines.join('\n');
}
