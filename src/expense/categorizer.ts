/**
 * AI-powered expense categorization, tuned for Singapore / Malaysia usage.
 */

import { getProviderForUser } from '../llm/provider';
import { findById } from '../users/service';
import { Category } from '../types';
import { logger } from '../utils/logger';

export const VALID_CATEGORIES: readonly Category[] = [
  'Food',
  'Transport',
  'Groceries',
  'Entertainment',
  'Bills',
  'Health',
  'Education',
  'Travel',
  'Shopping',
  'Others',
] as const;

interface CategorizationResult {
  category: Category;
  confidence: number;
}

function safeJsonParse(text: string): Partial<CategorizationResult> | null {
  try {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
      return null;
    }
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** The category a user named, matched case-insensitively, or null if it isn't one of ours. */
export function matchCategory(rawCategory: string): Category | null {
  const normalized = rawCategory.trim().toLowerCase();
  return VALID_CATEGORIES.find((cat) => cat.toLowerCase() === normalized) ?? null;
}

export function normalizeCategoryName(rawCategory: string): Category {
  return matchCategory(rawCategory) ?? 'Others';
}

/**
 * Use the calling user's own LLM provider to categorize an expense based on
 * merchant name and note. Falls back to 'Others' if categorization fails.
 */
export async function inferCategory(
  userId: string,
  input: { merchant?: string; note?: string; amount?: number },
): Promise<Category> {
  const haystack = [input.merchant, input.note].filter(Boolean).join(' ');

  if (!haystack.trim()) {
    return 'Others';
  }

  try {
    const user = await findById(userId);
    if (!user) {
      throw new Error(`No user found with id ${userId}`);
    }
    const provider = getProviderForUser(user);

    const prompt = `Merchant: "${input.merchant || 'unknown'}"
Note: "${input.note || ''}"
Amount: ${input.amount ? `$${(input.amount / 100).toFixed(2)}` : 'unknown'}

Return only JSON with category and confidence.`;

    const response = await provider.generateText({
      systemInstruction: `You are an expense categorization assistant for users in Singapore and Malaysia.
Categorize expenses into exactly one of these categories: ${VALID_CATEGORIES.join(', ')}.

Guidelines:
- Food: cafes, restaurants, hawker centers, kopi, mamak, food delivery
- Transport: Grab, taxis, MRT, LRT, buses, parking, fuel
- Groceries: supermarkets, FairPrice, Giant, Cold Storage, wet markets
- Entertainment: movies, Netflix, Spotify, concerts, games
- Bills: rent, utilities, phone bills, insurance, subscriptions
- Health: clinics, hospitals, pharmacies, doctors, medicine
- Education: tuition, courses, books, schools
- Travel: flights, hotels, AirAsia, Booking.com, trips
- Shopping: malls, clothes, electronics, online shopping
- Others: anything that doesn't fit above

Return only valid JSON with keys: category, confidence (0-1).`,
      contents: [{ text: prompt }],
    });

    const parsed = safeJsonParse(response);

    if (!parsed || !parsed.category) {
      logger.warn('Gemini categorization failed to return valid category', { response, haystack });
      return 'Others';
    }

    const category = normalizeCategoryName(parsed.category);
    logger.info('AI categorization', {
      merchant: input.merchant,
      note: input.note,
      category,
      confidence: parsed.confidence,
    });

    return category;
  } catch (error) {
    logger.error('Gemini categorization failed', error);
    return 'Others';
  }
}

/**
 * Merchants people pay for different kinds of things: Grab for rides, food
 * and groceries; Shopee or 7-Eleven for almost anything. Remembering the last
 * category for these would file every GrabFood order under Transport after
 * one ride, so their category always comes from the message instead.
 */
const MULTI_PURPOSE_MERCHANTS = ['grab', 'gojek', 'shopee', 'lazada', 'amazon', 'taobao', '7eleven', 'paypal'];

export function isMultiPurposeMerchant(merchant: string): boolean {
  const key = merchant.toLowerCase().replace(/[^a-z0-9]/g, '');
  return MULTI_PURPOSE_MERCHANTS.some((name) => key.startsWith(name));
}
