/**
 * Shared message formatting helpers for Telegram responses
 */

import { SpendingSummary } from '../../expense/types';

export function formatSpendingSummary(label: string, summary: SpendingSummary): string {
  const total = (summary.total / 100).toFixed(2);
  const topCategories =
    Object.entries(summary.byCategory)
      .map(([category, amount]) => `${category}: ${(amount / 100).toFixed(2)}`)
      .join(', ') || 'none';

  return `${label}: S$${total}.\nTransactions: ${summary.count}.\nBy category: ${topCategories}.`;
}

export function formatHeading(title: string): string {
  return `*${title}*`;
}

export function formatLines(title: string, lines: string[]): string {
  return [formatHeading(title), ...lines].join('\n');
}

export function formatHelpMessage(): string {
  return formatLines('Plutus commands', [
    '/portfolio - quick portfolio check',
    '/today - today\'s spend',
    '/month - monthly breakdown',
    '/budget - budget status',
    '/export - export your data',
    '/undo - undo the last transaction',
    '/split - split a bill from a receipt photo',
    '/cancel - cancel an in-progress split',
    '/digest - preview tonight\'s digest',
    '/help - this menu',
    '',
    'Or just message me naturally, like “Spent $4.50 at Ya Kun”.',
  ]);
}

export function formatUserFriendlyError(): string {
  return 'Oops — something hiccupped. Try again or use /help if you want a quick reset.';
}
