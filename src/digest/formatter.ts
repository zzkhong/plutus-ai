/**
 * Builds the digest message string from collected data. Pure — no I/O.
 */

import { DigestData, SectionResult } from './types';

function isError<T>(section: SectionResult<T>): section is { error: string } {
  return typeof section === 'object' && section !== null && 'error' in section;
}

function money(cents: number): string {
  return `S$${(cents / 100).toFixed(2)}`;
}

function formatDate(date: Date): string {
  return date.toLocaleDateString('en-SG', { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatSpendingSection(section: DigestData['spending']): string {
  if (isError(section)) {
    return `Spending: unavailable (${section.error})`;
  }

  if (section.total === 0) {
    return `Spent today: ${money(0)} — no spending today.`;
  }

  const lines = [`Spent today: ${money(section.total)}`];
  for (const [category, amount] of Object.entries(section.byCategory)) {
    const count = section.byCategoryCount[category] ?? 0;
    const label = count === 1 ? 'txn' : 'txns';
    lines.push(`  ${category}: ${money(amount)} (${count} ${label})`);
  }
  return lines.join('\n');
}

function formatRecurringSection(section: DigestData['recurringFired']): string | null {
  if (isError(section)) {
    return `Auto-logged: unavailable (${section.error})`;
  }

  if (section.length === 0) {
    return null;
  }

  return section
    .map((txn) => `Auto-logged: ${money(txn.amount_sgd)} ${txn.merchant} (recurring)`)
    .join('\n');
}

function formatBudgetSection(section: DigestData['budgetStatuses']): string | null {
  if (isError(section)) {
    return `Budget: unavailable (${section.error})`;
  }

  if (section.length === 0) {
    return null;
  }

  return section
    .map((status) => `Budget: ${status.category} ${status.percentage}% used (${status.days_left_in_month} days left)`)
    .join('\n');
}

function formatPortfolioSection(section: DigestData['portfolio']): string {
  return `Portfolio: unavailable (${section.error})`;
}

export function formatDigestMessage(data: DigestData, summaryLine: string): string {
  const sections = [`Daily Digest - ${formatDate(new Date())}`, '', formatSpendingSection(data.spending)];

  const recurring = formatRecurringSection(data.recurringFired);
  if (recurring) {
    sections.push('', recurring);
  }

  const budget = formatBudgetSection(data.budgetStatuses);
  if (budget) {
    sections.push('', budget);
  }

  sections.push('', formatPortfolioSection(data.portfolio));
  sections.push('', summaryLine);

  return sections.join('\n');
}
