/**
 * Generates the daily digest's portfolio market take.
 *
 * The LLM is never asked to guess prices or values — it is handed the
 * already-computed PortfolioSummary (real fetched quotes, real SGD values)
 * and reasons only about what today's news means for those numbers.
 */

import { getProviderForUser } from '../llm/provider';
import { findById } from '../users/service';
import { formatDay } from '../utils/dates';
import { PortfolioSummary, EnrichedHolding } from './types';

export const NO_HOLDINGS_MESSAGE =
  'No holdings on file yet — send me a brokerage statement as a file (PDF, screenshot or CSV) to get started.';

export const UNGROUNDED_CAVEAT = '(Based on general knowledge, not live market data.)';

/** Wall-clock budget for the advice call. A grounded call that fails falls
 * back to an ungrounded one, so the worst case is roughly twice this. */
const ADVICE_TIMEOUT_MS = 20000;

function money(cents: number): string {
  return `S$${(cents / 100).toFixed(2)}`;
}

function describeHolding(holding: EnrichedHolding): string {
  const base = `- ${holding.symbol} (${holding.name}), ${holding.quantity} units, ${holding.asset_class}, worth ${money(holding.value_sgd)}`;

  if (holding.asset_class === 'cash') {
    return `${base}, cash`;
  }
  if (!holding.quote) {
    return `${base}, price unavailable`;
  }
  if (holding.quote.change_pct === null) {
    return `${base}, valued at its ${formatDay(holding.quote.as_of)} statement price`;
  }

  const direction = holding.quote.change_pct >= 0 ? '+' : '';
  return `${base}, ${direction}${holding.quote.change_pct.toFixed(2)}% today`;
}

export function buildAdvicePrompt(summary: PortfolioSummary): string {
  const allocation = summary.by_class
    .map((entry) => `${entry.key} ${entry.pct.toFixed(1)}%`)
    .join(', ');

  return [
    `Net worth: ${money(summary.net_worth_sgd)}.`,
    allocation ? `Allocation: ${allocation}.` : '',
    '',
    'Holdings (real prices, already fetched — do not invent or restate different numbers):',
    ...summary.holdings.map(describeHolding),
    '',
    "Using today's market news, write a short plain-text market take for this portfolio:",
    '1. One or two sentences on how today overall affects this portfolio.',
    '2. Any specific holdings with notable news worth flagging (skip if none).',
    '3. A one-line hold / trim / rebalance lean.',
    '',
    'Be concise and concrete. No markdown, no bullets beyond short dashes, no preamble.',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/**
 * Returns the advice text for one user's portfolio. Throws on provider
 * failure so the digest's settle() wrapper degrades this section alone.
 */
export async function generatePortfolioAdvice(userId: string, summary: PortfolioSummary): Promise<string> {
  if (summary.holdings.length === 0) {
    return NO_HOLDINGS_MESSAGE;
  }

  const user = await findById(userId);
  if (!user) {
    throw new Error(`No user found with id ${userId}`);
  }
  const provider = getProviderForUser(user);

  const { text, grounded } = await provider.generateGroundedText({
    systemInstruction:
      'You are Pluto AI, a personal finance assistant writing the portfolio section of a nightly digest. Reply in plain text only.',
    contents: [{ text: buildAdvicePrompt(summary) }],
    timeoutMs: ADVICE_TIMEOUT_MS,
  });

  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error('Provider returned empty portfolio advice');
  }

  return grounded ? trimmed : `${trimmed}\n${UNGROUNDED_CAVEAT}`;
}
