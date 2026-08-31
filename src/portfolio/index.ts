/**
 * Portfolio module public API.
 */

import { getPrice } from './price-fetcher';
import { enrichHolding, buildPortfolioSummary, calculateNetWorth, calculateAllocation } from './calculator';
import { listHoldings } from './service';
import { PortfolioSummary } from './types';

export * from './types';
export { addHolding, removeHolding, replaceHoldingsForBroker, listHoldings } from './service';
export { parseStatement, StatementParseError } from './statement-parser';
export { getPrice } from './price-fetcher';
export { calculateNetWorth, calculateAllocation, enrichHolding, buildPortfolioSummary } from './calculator';

export async function getPortfolioSummary(): Promise<PortfolioSummary> {
  const holdings = await listHoldings();
  const enriched = await Promise.all(
    holdings.map(async (holding) => enrichHolding(holding, await getPrice(holding))),
  );
  return buildPortfolioSummary(enriched);
}
