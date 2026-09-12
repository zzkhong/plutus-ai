/**
 * Currency detection and resolution for expenses.
 *
 * Only a whole marker counts: the "rm" inside "Supermarket" or "Pharmacy" is
 * not a ringgit sign. And a bare "$" says nothing at all — a Singapore iPhone
 * writes S$4.50 as "$4.50" — so it falls through to the card's currency, then
 * SGD. Both used to be misread: every FairPrice Supermarket expense came out
 * in ringgit, and an Apple Pay "$4.50" in US dollars.
 */

import { Currency } from '../types';
import { DEFAULT_CARD_CURRENCY_MAP } from '../config';

// Not preceded by a letter; a letter code must not be followed by one either.
const MYR_MARKER = /(?<![a-z])(?:rm|myr)(?![a-z])/i;
const USD_MARKER = /(?<![a-z])(?:usd(?![a-z])|us\$)/i;
const SGD_MARKER = /(?<![a-z])(?:sgd(?![a-z])|s\$)/i;

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

/** The currency a piece of text names — "RM 45", "US$10", "S$20" — or undefined. */
export function detectCurrencyFromText(text?: string): Currency | undefined {
  if (!text) {
    return undefined;
  }
  if (MYR_MARKER.test(text)) {
    return 'MYR';
  }
  if (USD_MARKER.test(text)) {
    return 'USD';
  }
  if (SGD_MARKER.test(text)) {
    return 'SGD';
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

  const explicitFromText = detectCurrencyFromText(`${input.note ?? ''} ${input.merchant ?? ''}`);
  if (explicitFromText) {
    return explicitFromText;
  }

  return 'SGD';
}

/** The currency an amount string names, like the Apple Pay Shortcut's "RM45.00"; undefined for a bare "$4.50". */
export function parseExplicitCurrency(text?: string): Currency | undefined {
  return detectCurrencyFromText(text);
}
