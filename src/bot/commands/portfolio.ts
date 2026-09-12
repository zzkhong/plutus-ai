/**
 * /portfolio command handler
 */

import { getPortfolioSummary, EnrichedHolding } from '../../portfolio';
import { formatCurrency } from '../../config';
import { formatDay } from '../../utils/dates';

function describePrice(holding: EnrichedHolding): string {
  if (holding.asset_class === 'cash') {
    return 'cash';
  }
  if (!holding.quote) {
    return 'price unavailable';
  }
  if (holding.quote.change_pct === null) {
    return `statement price, ${formatDay(holding.quote.as_of)}`;
  }
  const sign = holding.quote.change_pct >= 0 ? '+' : '';
  return `${sign}${holding.quote.change_pct.toFixed(2)}% today`;
}

export async function handlePortfolioCommand(userId: string): Promise<string> {
  const summary = await getPortfolioSummary(userId);

  if (summary.holdings.length === 0) {
    return 'No holdings yet. Send me a brokerage statement as a file (PDF, screenshot or CSV), or tell me something like "I hold 0.5 BTC" or "cash SGD 5000" to get started.';
  }

  const unpricedCount = summary.holdings.filter((h) => h.quote === null && h.asset_class !== 'cash').length;

  const lines = [`Net worth: ${formatCurrency(summary.net_worth_sgd, 'SGD')}`];
  if (unpricedCount > 0) {
    lines.push(
      `⚠️ ${unpricedCount} holding${unpricedCount === 1 ? '' : 's'} could not be priced and ${unpricedCount === 1 ? 'is' : 'are'} excluded from the total.`,
    );
  }
  lines.push('', 'By asset class:');
  for (const entry of summary.by_class) {
    lines.push(`  ${entry.key}: ${formatCurrency(entry.value_sgd, 'SGD')} (${entry.pct}%)`);
  }

  lines.push('', 'By currency:');
  for (const entry of summary.by_currency) {
    lines.push(`  ${entry.key}: ${formatCurrency(entry.value_sgd, 'SGD')} (${entry.pct}%)`);
  }

  lines.push('', 'Holdings:');
  for (const holding of summary.holdings) {
    lines.push(
      `  ${holding.symbol}: ${holding.quantity} — ${formatCurrency(holding.value_sgd, 'SGD')} (${describePrice(holding)})`,
    );
  }

  return lines.join('\n');
}
