/**
 * Pure net worth and allocation math. No I/O — takes holdings, their
 * already-resolved price quotes, and the exchange rates, and produces a
 * PortfolioSummary.
 */

import { ExchangeRates, toSGD } from '../config/currencies';
import { AllocationEntry, EnrichedHolding, Holding, PortfolioSummary, PriceQuote } from './types';

function computeValueSgd(holding: Holding, quote: PriceQuote | null, rates: ExchangeRates): number {
  if (holding.asset_class === 'cash') {
    const value = toSGD(Math.round(holding.quantity * 100), holding.currency, rates);
    return Number.isFinite(value) ? value : 0;
  }
  if (!quote) {
    return 0;
  }
  const valueInQuoteCurrency = holding.quantity * quote.price;
  const value = toSGD(Math.round(valueInQuoteCurrency * 100), quote.currency, rates);
  return Number.isFinite(value) ? value : 0;
}

export function enrichHolding(holding: Holding, quote: PriceQuote | null, rates: ExchangeRates): EnrichedHolding {
  return { ...holding, quote, value_sgd: computeValueSgd(holding, quote, rates) };
}

export function calculateNetWorth(holdings: EnrichedHolding[]): number {
  return holdings.reduce((sum, h) => sum + h.value_sgd, 0);
}

function buildAllocation(holdings: EnrichedHolding[], keyOf: (h: EnrichedHolding) => string): AllocationEntry[] {
  const totals = new Map<string, number>();
  for (const h of holdings) {
    const key = keyOf(h);
    totals.set(key, (totals.get(key) ?? 0) + h.value_sgd);
  }

  const netWorth = calculateNetWorth(holdings);

  return Array.from(totals.entries()).map(([key, value_sgd]) => ({
    key,
    value_sgd,
    pct: netWorth > 0 ? Math.round((value_sgd / netWorth) * 1000) / 10 : 0,
  }));
}

export function calculateAllocation(
  holdings: EnrichedHolding[],
): { by_class: AllocationEntry[]; by_currency: AllocationEntry[] } {
  return {
    by_class: buildAllocation(holdings, (h) => h.asset_class),
    by_currency: buildAllocation(holdings, (h) => h.currency),
  };
}

export function buildPortfolioSummary(holdings: EnrichedHolding[]): PortfolioSummary {
  const { by_class, by_currency } = calculateAllocation(holdings);
  return {
    net_worth_sgd: calculateNetWorth(holdings),
    by_class,
    by_currency,
    holdings,
  };
}
