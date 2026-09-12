/**
 * Generates the digest's closing one-liner via Gemini, falling back to a
 * rule-based line if the call fails, times out, or returns nothing.
 */

import { getProviderForUser } from '../llm/provider';
import { findById } from '../users/service';
import { logger } from '../utils/logger';
import { DigestData, SectionResult } from './types';

function isError<T>(section: SectionResult<T>): section is { error: string } {
  return typeof section === 'object' && section !== null && 'error' in section;
}

function ruleBasedSummary(data: DigestData): string {
  if (!isError(data.budgetStatuses)) {
    const overThreshold = data.budgetStatuses.find((status) => status.percentage >= 80);
    if (overThreshold) {
      return `Watch ${overThreshold.category} spending.`;
    }
  }
  return 'All good.';
}

function buildPrompt(data: DigestData): string {
  const totalCents = isError(data.spending) ? 0 : data.spending.total;
  const topCategory = isError(data.spending)
    ? null
    : Object.entries(data.spending.byCategory).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  return `Today's spending: S$${(totalCents / 100).toFixed(2)}${
    topCategory ? `, mostly on ${topCategory}` : ''
  }. Write one short, friendly one-line comment (under 15 words, no emoji) for a personal finance digest message.`;
}

export async function generateSummaryLine(userId: string, data: DigestData): Promise<string> {
  try {
    const user = await findById(userId);
    if (!user) {
      throw new Error(`No user found with id ${userId}`);
    }
    const provider = getProviderForUser(user);

    const text = (
      await provider.generateText({
        systemInstruction:
          'You are Plutus AI, a personal finance assistant. Reply with exactly one short plain-text sentence, no markdown, no quotes.',
        contents: [{ text: buildPrompt(data) }],
        timeoutMs: 5000,
      })
    ).trim();

    if (!text) {
      logger.warn('Gemini returned an empty digest summary, falling back to rule-based line');
      return ruleBasedSummary(data);
    }

    return text;
  } catch (error) {
    logger.error('Gemini digest summary failed, falling back to rule-based line', error);
    return ruleBasedSummary(data);
  }
}
