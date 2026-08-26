/**
 * AI-powered expense categorization using Gemini, tuned for Singapore / Malaysia usage.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from '../config';
import { Category } from '../types';
import { logger } from '../utils/logger';

const VALID_CATEGORIES: readonly Category[] = [
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

export function normalizeCategoryName(rawCategory: string): Category {
  const normalized = rawCategory.trim();

  // Find exact match (case-insensitive)
  const match = VALID_CATEGORIES.find(
    (cat) => cat.toLowerCase() === normalized.toLowerCase()
  );

  return match || 'Others';
}

/**
 * Use Gemini to categorize an expense based on merchant name and note.
 * Falls back to 'Others' if categorization fails.
 */
export async function inferCategory(input: {
  merchant?: string;
  note?: string;
  amount?: number;
}): Promise<Category> {
  const haystack = [input.merchant, input.note].filter(Boolean).join(' ');

  if (!haystack.trim()) {
    return 'Others';
  }

  try {
    const genAI = new GoogleGenerativeAI(config.GOOGLE_API_KEY);
    const model = genAI.getGenerativeModel({
      model: 'gemini-3.6-flash',
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
    });

    const prompt = `Merchant: "${input.merchant || 'unknown'}"
Note: "${input.note || ''}"
Amount: ${input.amount ? `$${(input.amount / 100).toFixed(2)}` : 'unknown'}

Return only JSON with category and confidence.`;

    const result = await model.generateContent(prompt);
    const response = result.response.text();
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
