/**
 * Expense categorizations tuned for Singapore / Malaysia usage.
 */

import { Category } from '../types';

const categoryPatterns: Array<{ pattern: RegExp; category: Category }> = [
  { pattern: /(kopi|coffee|cafe|mamak|hawker|restaurant|lunch|dinner|nasi|mee|tea|bakery|food|snack|breakfast)/i, category: 'Food' },
  { pattern: /(grab|uber|taxi|bus|train|mrt|lrt|transport|commute|ride|parking|fuel|petrol)/i, category: 'Transport' },
  { pattern: /(supermarket|grocer|market|cold storage|fairprice|giant|tesco|aeon|shell|groceries)/i, category: 'Groceries' },
  { pattern: /(netflix|spotify|movie|cinema|games|steam|concert|karaoke|entertainment|theater)/i, category: 'Entertainment' },
  { pattern: /(rent|insurance|telco|electric|water|internet|utility|bill|phone|mobile|pln|streaming|subscription)/i, category: 'Bills' },
  { pattern: /(clinic|hospital|pharmacy|doctor|medicine|health|vitamin|gp|dentist)/i, category: 'Health' },
  { pattern: /(school|tuition|course|bookshop|education|study|exam|university)/i, category: 'Education' },
  { pattern: /(flight|hotel|airasia|booking|travel|airline|hostel|trip|visa)/i, category: 'Travel' },
  { pattern: /(mall|shop|clothes|shoes|bag|amazon|fashion|retail|shopping)/i, category: 'Shopping' },
];

export function normalizeCategoryName(rawCategory: string): Category {
  const normalized = rawCategory.trim();
  if (!normalized) {
    return 'Others';
  }

  for (const entry of categoryPatterns) {
    if (entry.pattern.test(normalized)) {
      return entry.category;
    }
  }

  return 'Others';
}

export function inferCategory(input: { merchant?: string; note?: string }): Category {
  const haystack = [input.merchant, input.note].filter(Boolean).join(' ');
  return normalizeCategoryName(haystack);
}
