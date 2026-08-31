/**
 * /portfolio command handler
 */

import { getPortfolioSummary } from '../../portfolio';
import { formatCurrency } from '../../config';

export async function handlePortfolioCommand(): Promise<string> {
  const summary = await getPortfolioSummary();

  if (summary.holdings.length === 0) {
    return 'No holdings yet. Upload an IBKR/Moomoo statement PDF, or tell me something like "I hold 0.5 BTC" or "cash SGD 5000" to get started.';
  }

  const lines = [`Net worth: ${formatCurrency(summary.net_worth_sgd, 'SGD')}`, '', 'By asset class:'];
  for (const entry of summary.by_class) {
    lines.push(`  ${entry.key}: ${formatCurrency(entry.value_sgd, 'SGD')} (${entry.pct}%)`);
  }

  lines.push('', 'By currency:');
  for (const entry of summary.by_currency) {
    lines.push(`  ${entry.key}: ${formatCurrency(entry.value_sgd, 'SGD')} (${entry.pct}%)`);
  }

  lines.push('', 'Holdings:');
  for (const holding of summary.holdings) {
    const movement = holding.quote
      ? `${holding.quote.change_pct >= 0 ? '+' : ''}${holding.quote.change_pct.toFixed(2)}%`
      : 'price unavailable';
    lines.push(`  ${holding.symbol}: ${holding.quantity} — ${formatCurrency(holding.value_sgd, 'SGD')} (${movement})`);
  }

  return lines.join('\n');
}
