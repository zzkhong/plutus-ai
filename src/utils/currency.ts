/**
 * Currency utility functions
 */

import { Currency } from '../types';
import { convertCurrency, toSGD, formatCurrency, CURRENCIES } from '../config';

/**
 * Currency conversion utilities for the application
 */
export const currencyUtils = {
  /**
   * Convert amount from one currency to another
   */
  convert: (amount: number, from: Currency, to: Currency) =>
    convertCurrency(amount, from, to),

  /**
   * Convert any amount to SGD (base currency)
   */
  toSGD: (amount: number, currency: Currency) => toSGD(amount, currency),

  /**
   * Format amount as display string with currency symbol
   */
  format: (amount: number, currency: Currency) => formatCurrency(amount, currency),

  /**
   * Get currency name
   */
  getName: (currency: Currency) => CURRENCIES[currency].name,

  /**
   * Get currency symbol
   */
  getSymbol: (currency: Currency) => CURRENCIES[currency].symbol,
};

export default currencyUtils;
