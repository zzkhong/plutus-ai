/**
 * Portfolio module public API.
 */

import { getPrice } from './price-fetcher';
import { enrichHolding, buildPortfolioSummary } from './calculator';
import { listHoldings } from './service';
import { PortfolioSummary } from './types';

export * from './types';
export { addHolding, removeHolding, replaceHoldingsForBroker, listHoldings } from './service';
export { parseStatement, StatementParseError } from './statement-parser';
export { getPrice } from './price-fetcher';
export { calculateNetWorth, calculateAllocation, enrichHolding, buildPortfolioSummary } from './calculator';

export async function getPortfolioSummary(userId: string): Promise<PortfolioSummary> {
  const holdingsList = await listHoldings(userId);
  const enriched = await Promise.all(
    holdingsList.map(async (holding) => enrichHolding(holding, await getPrice(holding))),
  );
  return buildPortfolioSummary(enriched);
}
