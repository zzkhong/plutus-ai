/**
 * Reads a receipt photo as a single expense: who, how much, when, and what
 * kind of spending.
 *
 * Deliberately lighter than /split's extraction (src/split/extraction.ts),
 * which needs every line item and checks they add up to the total. A
 * supermarket receipt with discounts, deposits or points would fail that
 * check, and an expense only needs the total. Same no-fallback rule: a
 * photo that can't be read throws ReceiptReadError.
 */

import { getProviderForUser } from '../llm/provider';
import { findById } from '../users/service';
import { Category, Currency } from '../types';
import { matchCategory, VALID_CATEGORIES } from './categorizer';

export class ReceiptReadError extends Error {}

export interface ReceiptExpense {
  merchant: string | null;
  total: number; // in major units, e.g. 23.40
  currency: Currency;
  date: string | null; // "YYYY-MM-DD" as printed, unvalidated
  category: Category | null;
}

const VALID_CURRENCIES = new Set(['SGD', 'MYR', 'USD']);

const SYSTEM_INSTRUCTION = `You read receipts for a personal finance assistant used in Singapore and Malaysia. From the photo, extract the merchant, the final total actually paid (after discounts, including tax and service charge), its currency, the date printed on the receipt, and the best expense category. Return strict JSON only, exactly this shape:
{"isReceipt": true, "merchant": string | null, "total": number, "currency": "SGD" | "MYR" | "USD" | other ISO 4217 code, "date": "YYYY-MM-DD" | null, "category": ${VALID_CATEGORIES.map((c) => `"${c}"`).join(' | ')}}
The total is a plain decimal number with no currency symbol. If the photo is not a receipt, bill or invoice, or its total is unreadable, return {"isReceipt": false}.`;

export function parseReceiptExpense(rawText: string): ReceiptExpense {
  const start = rawText.indexOf('{');
  const end = rawText.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new ReceiptReadError('The model returned an unparseable response');
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawText.slice(start, end + 1));
  } catch {
    throw new ReceiptReadError('The model returned invalid JSON');
  }

  if (parsed.isReceipt === false) {
    throw new ReceiptReadError('Not a receipt');
  }
  if (typeof parsed.total !== 'number' || !Number.isFinite(parsed.total) || parsed.total <= 0) {
    throw new ReceiptReadError('Missing or invalid total');
  }
  const currency = typeof parsed.currency === 'string' ? parsed.currency.trim().toUpperCase() : '';
  if (!VALID_CURRENCIES.has(currency)) {
    throw new ReceiptReadError(`Unsupported currency: ${currency || 'none'}`);
  }

  const merchant = typeof parsed.merchant === 'string' && parsed.merchant.trim() !== '' ? parsed.merchant.trim() : null;
  return {
    merchant,
    total: Math.round(parsed.total * 100) / 100,
    currency: currency as Currency,
    date: typeof parsed.date === 'string' ? parsed.date : null,
    category: typeof parsed.category === 'string' ? matchCategory(parsed.category) : null,
  };
}

export async function readReceipt(userId: string, photo: Buffer, mimeType: string): Promise<ReceiptExpense> {
  try {
    const user = await findById(userId);
    if (!user) {
      throw new ReceiptReadError(`No user found with id ${userId}`);
    }
    const provider = getProviderForUser(user);

    // Vision calls run slower than text classification; 30s matches /split's extraction.
    const response = await provider.generateText({
      systemInstruction: SYSTEM_INSTRUCTION,
      contents: [
        { inlineData: { mimeType, data: photo.toString('base64') } },
        { text: 'Read this receipt as instructed and return only the JSON.' },
      ],
      timeoutMs: 30000,
    });

    return parseReceiptExpense(response);
  } catch (error) {
    if (error instanceof ReceiptReadError) {
      throw error;
    }
    throw new ReceiptReadError(`Receipt reading failed: ${(error as Error).message}`);
  }
}
