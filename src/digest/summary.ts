/**
 * Generates the digest's closing one-liner via Gemini, falling back to a
 * rule-based line if the call fails, times out, or returns nothing.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from '../config';
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

export async function generateSummaryLine(data: DigestData): Promise<string> {
  try {
    const genAI = new GoogleGenerativeAI(config.GOOGLE_API_KEY);
    const model = genAI.getGenerativeModel({
      model: 'gemini-3.6-flash',
      systemInstruction:
        'You are Pluto AI, a personal finance assistant. Reply with exactly one short plain-text sentence, no markdown, no quotes.',
    });

    let timeoutHandle: NodeJS.Timeout;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error('Gemini summary call timed out after 5s')), 5000);
    });

    try {
      const result = await Promise.race([model.generateContent(buildPrompt(data)), timeoutPromise]);
      clearTimeout(timeoutHandle!);
      const text = result.response.text().trim();

      if (!text) {
        logger.warn('Gemini returned an empty digest summary, falling back to rule-based line');
        return ruleBasedSummary(data);
      }

      return text;
    } catch (error) {
      clearTimeout(timeoutHandle!);
      throw error;
    }
  } catch (error) {
    logger.error('Gemini digest summary failed, falling back to rule-based line', error);
    return ruleBasedSummary(data);
  }
}
