/**
 * Extracts line items from a photo of a receipt via Gemini multimodal
 * vision. No rule-based fallback — any failure surfaces as
 * ExtractionError, matching the degrade-don't-guess convention used by
 * src/portfolio/statement-parser.ts.
 */

import { getProviderForUser } from '../llm/provider';
import { findById } from '../users/service';
import { Currency } from '../types';
import { ExtractedReceipt, ReceiptItem } from './types';

export class ExtractionError extends Error {}

const VALID_CURRENCIES = new Set(['SGD', 'MYR', 'USD']);

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

const SYSTEM_INSTRUCTION = `You are a receipt parser for Plutus AI's bill-splitting feature. You will receive a photo of a restaurant/food receipt. Extract every purchased line item (not tax, not service charge, not tip, not the total) with its price, plus the merchant name if visible, the currency, the sum of any tax/service charge/tip lines, and the final total. Return strict JSON only, matching exactly this shape:
{"merchant": string | null, "items": [{"name": string, "price": number}], "taxAndTip": number, "total": number, "currency": "SGD" | "MYR" | "USD"}
Prices are plain decimal numbers, no currency symbols. A plain "$" on a Singapore receipt is SGD, not USD. If you cannot read the receipt clearly, return {"merchant": null, "items": [], "taxAndTip": 0, "total": 0, "currency": "SGD"}.`;

export function parseGeminiReceiptResponse(rawText: string): ExtractedReceipt {
  const start = rawText.indexOf('{');
  const end = rawText.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new ExtractionError('Gemini returned an unparseable response');
  }

  let parsed: {
    merchant?: string | null;
    items?: unknown[];
    taxAndTip?: unknown;
    total?: unknown;
    currency?: string;
  };
  try {
    parsed = JSON.parse(rawText.slice(start, end + 1));
  } catch {
    throw new ExtractionError('Gemini returned invalid JSON');
  }

  const rawItems = (parsed.items ?? []) as unknown[];
  if (rawItems.length === 0) {
    throw new ExtractionError('No line items found on the receipt — try a clearer photo');
  }

  const validatedItems: ReceiptItem[] = rawItems.map((raw, index) => {
    const item = raw as Record<string, unknown>;
    if (typeof item.name !== 'string' || item.name.trim() === '') {
      throw new ExtractionError(`Item ${index} is missing a valid name`);
    }
    if (typeof item.price !== 'number' || !Number.isFinite(item.price) || item.price <= 0) {
      throw new ExtractionError(`Item ${index} (${item.name}) has an invalid price`);
    }
    return { name: item.name, price: item.price };
  });

  // Merge items that share a name (e.g. the same drink ordered twice as two
  // separate lines) so downstream name-keyed lookups (calculator.ts,
  // assignment.ts) never silently collapse one of them and drop its price.
  const mergedByName = new Map<string, number>();
  for (const item of validatedItems) {
    mergedByName.set(item.name, round2((mergedByName.get(item.name) ?? 0) + item.price));
  }
  const items: ReceiptItem[] = Array.from(mergedByName.entries()).map(([name, price]) => ({ name, price }));

  if (typeof parsed.taxAndTip !== 'number' || !Number.isFinite(parsed.taxAndTip) || parsed.taxAndTip < 0) {
    throw new ExtractionError('Missing or invalid taxAndTip');
  }
  if (typeof parsed.total !== 'number' || !Number.isFinite(parsed.total) || parsed.total <= 0) {
    throw new ExtractionError('Missing or invalid total');
  }
  if (typeof parsed.currency !== 'string' || !VALID_CURRENCIES.has(parsed.currency)) {
    throw new ExtractionError('Missing or unrecognized currency');
  }

  const itemsSum = items.reduce((sum, item) => sum + item.price, 0);
  const expectedTotal = itemsSum + parsed.taxAndTip;
  const tolerance = Math.max(0.5, parsed.total * 0.02);
  if (Math.abs(expectedTotal - parsed.total) > tolerance) {
    throw new ExtractionError(
      `The receipt's line items and total don't add up (items+tax/tip: ${expectedTotal.toFixed(2)}, stated total: ${parsed.total.toFixed(2)}) — try a clearer photo`,
    );
  }

  return {
    merchant: typeof parsed.merchant === 'string' && parsed.merchant.trim() !== '' ? parsed.merchant : null,
    items,
    taxAndTip: parsed.taxAndTip,
    total: parsed.total,
    currency: parsed.currency as Currency,
  };
}

export async function extractReceipt(userId: string, photoBuffer: Buffer, mimeType: string): Promise<ExtractedReceipt> {
  try {
    const user = await findById(userId);
    if (!user) {
      throw new ExtractionError(`No user found with id ${userId}`);
    }
    const provider = getProviderForUser(user);

    // Vision calls run slower than short text-classification prompts (ai.ts's
    // 15s budget) — 30s gives enough headroom, matching statement-parser.ts.
    const response = await provider.generateText({
      systemInstruction: SYSTEM_INSTRUCTION,
      contents: [
        { inlineData: { mimeType, data: photoBuffer.toString('base64') } },
        { text: 'Extract the receipt as instructed and return only the JSON.' },
      ],
      timeoutMs: 30000,
    });

    return parseGeminiReceiptResponse(response);
  } catch (error) {
    if (error instanceof ExtractionError) {
      throw error;
    }
    throw new ExtractionError(`Gemini receipt extraction failed: ${(error as Error).message}`);
  }
}
