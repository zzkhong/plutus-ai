/**
 * Currency detection and resolution for expenses.
 */

import { Currency } from '../types';
import { DEFAULT_CARD_CURRENCY_MAP } from '../config';

const EXPLICIT_CURRENCY_RE = /(SGD|USD|MYR|RM|\$)/i;

export function detectCurrencyFromCard(cardName?: string): Currency | undefined {
  if (!cardName) {
    return undefined;
  }

  const normalizedName = cardName.toLowerCase();
  const matchedKey = Object.keys(DEFAULT_CARD_CURRENCY_MAP).find((card) => normalizedName.includes(card.toLowerCase()));

  if (!matchedKey) {
    return undefined;
  }

  return DEFAULT_CARD_CURRENCY_MAP[matchedKey];
}

export function detectCurrencyFromText(text?: string): Currency | undefined {
  if (!text) {
    return undefined;
  }

  const normalized = text.trim();
  if (/RM|MYR/i.test(normalized)) {
    return 'MYR';
  }
  if (/USD|US\$|\$\s?\d/i.test(normalized)) {
    return 'USD';
  }
  if (/SGD|S\$/i.test(normalized)) {
    return 'SGD';
  }
  if (/\$\s?\d/i.test(normalized) && !/(RM|MYR|USD|SGD|S\$)/i.test(normalized)) {
    return 'USD';
  }

  return undefined;
}

export function resolveCurrency(input: {
  currency?: Currency;
  cardName?: string;
  merchant?: string;
  note?: string;
}): Currency {
  if (input.currency) {
    return input.currency;
  }

  const cardCurrency = detectCurrencyFromCard(input.cardName);
  if (cardCurrency) {
    return cardCurrency;
  }

  const textCandidate = `${input.note ?? ''} ${input.merchant ?? ''}`;
  const explicitFromText = detectCurrencyFromText(textCandidate);
  if (explicitFromText) {
    return explicitFromText;
  }

  return 'SGD';
}

export function parseExplicitCurrency(text?: string): Currency | undefined {
  if (!text) {
    return undefined;
  }

  if (/RM|MYR/i.test(text)) {
    return 'MYR';
  }
  if (/SGD|S\$/i.test(text)) {
    return 'SGD';
  }
  if (/USD|US\$/i.test(text) || (text.includes('$') && !/RM|MYR|SGD|S\$/i.test(text))) {
    return 'USD';
  }

  return undefined;
}

export const EXPLICIT_CURRENCY_PATTERN = EXPLICIT_CURRENCY_RE;
