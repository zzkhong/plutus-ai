/**
 * Transaction and recurring expense service.
 */

import { randomUUID } from 'crypto';
import { and, desc, eq, gt, gte, lt, or } from 'drizzle-orm';

import { SUPPORTED_CURRENCIES, toSGD } from '../config';
import { getExchangeRates } from '../fx/rates';
import { db } from '../db';
import { transactions, recurring_transactions } from '../db/schema';
import { Category, Currency, Transaction, RecurringTransaction } from '../types';
import { inferCategory, matchCategory } from './categorizer';
import { resolveCurrency } from './currency-resolver';
import {
  Comparison,
  ExpenseInput,
  RecurringInput,
  SpendingPeriod,
  SpendingSummary,
} from './types';

function centsFromAmount(amount: number): number {
  return Math.max(0, Math.round(amount * 100));
}

function startOfPeriod(period: SpendingPeriod, now: Date = new Date()): number {
  const start = new Date(now);

  if (period === 'today') {
    start.setHours(0, 0, 0, 0);
    return start.getTime();
  }

  if (period === 'week') {
    start.setDate(now.getDate() - 6);
    start.setHours(0, 0, 0, 0);
    return start.getTime();
  }

  start.setDate(1);
  start.setHours(0, 0, 0, 0);
  return start.getTime();
}

function mapTransactionRow(row: typeof transactions.$inferSelect): Transaction {
  return {
    id: row.id,
    amount: row.amount,
    currency: row.currency as Currency,
    amount_sgd: row.amount_sgd,
    merchant: row.merchant,
    category: row.category as Category,
    source: row.source,
    card_name: row.card_name,
    note: row.note ?? undefined,
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at),
  };
}

export async function logExpense(userId: string, data: ExpenseInput): Promise<Transaction> {
  const normalizedCurrency = resolveCurrency({
    currency: data.currency,
    cardName: data.cardName,
    merchant: data.merchant,
    note: data.note,
  });

  const amountCents = centsFromAmount(data.amount);
  const merchant = (data.merchant ?? 'Unknown merchant').trim() || 'Unknown merchant';
  const category = await inferCategory(userId, { merchant, note: data.note, amount: amountCents });
  const now = Date.now();
  const amountSgd = toSGD(amountCents, normalizedCurrency, await getExchangeRates());

  const [inserted] = await db
    .insert(transactions)
    .values({
      id: randomUUID(),
      user_id: userId,
      amount: amountCents,
      currency: normalizedCurrency,
      amount_sgd: amountSgd,
      merchant,
      category,
      source: data.source ?? 'text',
      card_name: data.cardName ?? 'General',
      note: data.note ?? null,
      created_at: now,
      updated_at: now,
    })
    .returning();

  return mapTransactionRow(inserted);
}

export async function undoLastTransaction(userId: string): Promise<Transaction | null> {
  const row = await db
    .select()
    .from(transactions)
    .where(eq(transactions.user_id, userId))
    .orderBy(desc(transactions.created_at))
    .limit(1)
    .get();

  if (!row) {
    return null;
  }

  await db.delete(transactions).where(eq(transactions.id, row.id));
  return mapTransactionRow(row);
}

export async function getSpendingSummary(userId: string, period: SpendingPeriod): Promise<SpendingSummary> {
  const start = startOfPeriod(period);
  const rows = await db
    .select()
    .from(transactions)
    .where(and(eq(transactions.user_id, userId), gte(transactions.created_at, start)))
    .orderBy(desc(transactions.created_at));

  const byCategory: Record<string, number> = {};
  const byCategoryCount: Record<string, number> = {};
  let total = 0;

  for (const row of rows) {
    total += row.amount_sgd;
    byCategory[row.category] = (byCategory[row.category] ?? 0) + row.amount_sgd;
    byCategoryCount[row.category] = (byCategoryCount[row.category] ?? 0) + 1;
  }

  return {
    period,
    total,
    count: rows.length,
    byCategory,
    byCategoryCount,
    topExpenses: rows.slice(0, 5).map(mapTransactionRow),
  };
}

export async function getSpendingByCategory(
  userId: string,
  period: SpendingPeriod,
): Promise<{ category: string; total: number }[]> {
  const summary = await getSpendingSummary(userId, period);
  return Object.entries(summary.byCategory).map(([category, total]) => ({ category, total }));
}

export async function getTopExpenses(userId: string, period: SpendingPeriod, limit = 5): Promise<Transaction[]> {
  const start = startOfPeriod(period);
  const rows = await db
    .select()
    .from(transactions)
    .where(and(eq(transactions.user_id, userId), gte(transactions.created_at, start)))
    .orderBy(desc(transactions.created_at))
    .limit(limit);
  return rows.map(mapTransactionRow);
}

export async function compareSpending(
  userId: string,
  period1: SpendingPeriod,
  period2: SpendingPeriod,
): Promise<Comparison> {
  const summaryA = await getSpendingSummary(userId, period1);
  const summaryB = await getSpendingSummary(userId, period2);
  return {
    period1: summaryA,
    period2: summaryB,
    delta: summaryA.total - summaryB.total,
  };
}

export async function correctLastTransaction(userId: string, field: string, value: string): Promise<Transaction | null> {
  const row = await db
    .select()
    .from(transactions)
    .where(eq(transactions.user_id, userId))
    .orderBy(desc(transactions.created_at))
    .limit(1)
    .get();

  if (!row) {
    return null;
  }

  const normalizedField = field.toLowerCase();
  const updates: Partial<typeof transactions.$inferInsert> = { updated_at: Date.now() };

  if (normalizedField === 'merchant') {
    updates.merchant = value;
  } else if (normalizedField === 'category') {
    // A category the user names outright is used as-is — the categorizer
    // could otherwise overrule them. Anything else is a hint for it.
    updates.category =
      matchCategory(value) ?? (await inferCategory(userId, { merchant: row.merchant, note: value, amount: row.amount }));
  } else if (normalizedField === 'note') {
    updates.note = value;
  } else if (normalizedField === 'amount') {
    const nextAmount = centsFromAmount(Number(value));
    const resolvedCurrency = resolveCurrency({
      currency: row.currency as Currency,
      cardName: row.card_name,
      merchant: row.merchant,
      note: row.note ?? undefined,
    });
    updates.amount = nextAmount;
    updates.amount_sgd = toSGD(nextAmount, resolvedCurrency, await getExchangeRates());
  } else if (normalizedField === 'currency') {
    const nextCurrency = resolveCurrency({
      // Only SGD, MYR and USD have exchange rates; anything else keeps the current currency.
      currency: SUPPORTED_CURRENCIES.includes(value.trim().toUpperCase() as Currency)
        ? (value.trim().toUpperCase() as Currency)
        : (row.currency as Currency),
      cardName: row.card_name,
      merchant: row.merchant,
      note: row.note ?? undefined,
    });
    updates.currency = nextCurrency;
    updates.amount_sgd = toSGD(row.amount, nextCurrency, await getExchangeRates());
  }

  const [updated] = await db.update(transactions).set(updates).where(eq(transactions.id, row.id)).returning();
  return mapTransactionRow(updated);
}

export interface CsvExport {
  year: number;
  filename: string;
  content: string;
  rowCount: number;
}

/** Builds one calendar year of the user's transactions as CSV, in memory — nothing touches disk. */
export async function exportCSV(userId: string, year: number): Promise<CsvExport> {
  const rows = await db
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.user_id, userId),
        gte(transactions.created_at, new Date(year, 0, 1).getTime()),
        lt(transactions.created_at, new Date(year + 1, 0, 1).getTime()),
      ),
    )
    .orderBy(desc(transactions.created_at));

  const lines = [
    ['id', 'amount', 'currency', 'amount_sgd', 'merchant', 'category', 'source', 'card_name', 'note', 'created_at'].join(','),
    ...rows.map((row: typeof transactions.$inferSelect) =>
      [
        row.id,
        row.amount,
        row.currency,
        row.amount_sgd,
        row.merchant,
        row.category,
        row.source,
        row.card_name,
        row.note ?? '',
        row.created_at,
      ]
        .map((value) => `"${String(value).replace(/"/g, '""')}"`)
        .join(','),
    ),
  ];

  return {
    year,
    filename: `plutus-expenses-${year}.csv`,
    content: `${lines.join('\n')}\n`,
    rowCount: rows.length,
  };
}

// --- Recurring-transaction functions ---

function mapRecurringRow(row: typeof recurring_transactions.$inferSelect): RecurringTransaction {
  return {
    id: row.id,
    amount: row.amount,
    currency: row.currency as Currency,
    merchant: row.merchant,
    category: row.category as Category,
    day_of_month: row.day_of_month,
    is_active: Boolean(row.is_active),
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at),
  };
}

export async function createRecurring(userId: string, data: RecurringInput): Promise<RecurringTransaction> {
  const amount = centsFromAmount(data.amount);
  const category = data.category ?? (await inferCategory(userId, { merchant: data.merchant, amount }));
  const now = Date.now();

  const [inserted] = await db
    .insert(recurring_transactions)
    .values({
      id: randomUUID(),
      user_id: userId,
      amount,
      currency: data.currency ?? 'SGD',
      merchant: data.merchant,
      category,
      day_of_month: data.day_of_month,
      is_active: data.is_active === undefined ? 1 : data.is_active ? 1 : 0,
      created_at: now,
      updated_at: now,
    })
    .returning();

  return mapRecurringRow(inserted);
}

export async function pauseRecurring(userId: string, id: string): Promise<void> {
  await db
    .update(recurring_transactions)
    .set({ is_active: 0, updated_at: Date.now() })
    .where(and(eq(recurring_transactions.id, id), eq(recurring_transactions.user_id, userId)));
}

export async function removeRecurring(userId: string, id: string): Promise<void> {
  await db
    .delete(recurring_transactions)
    .where(and(eq(recurring_transactions.id, id), eq(recurring_transactions.user_id, userId)));
}

export async function listRecurring(userId: string): Promise<RecurringTransaction[]> {
  const rows = await db
    .select()
    .from(recurring_transactions)
    .where(eq(recurring_transactions.user_id, userId))
    .orderBy(recurring_transactions.day_of_month);
  return rows.map(mapRecurringRow);
}

/**
 * Logs every recurring charge due today. `at` is injectable for tests.
 *
 * A template's day may not exist this month — the 31st in September, the
 * 30th in February. Those fire on the month's last day rather than being
 * skipped, which is what happened before: a charge on the 31st went missing
 * five months a year.
 */
export async function fireRecurringForToday(userId: string, at: Date = new Date()): Promise<Transaction[]> {
  const today = at.getDate();
  const lastDayOfMonth = new Date(at.getFullYear(), at.getMonth() + 1, 0).getDate();
  const dueRows = await db
    .select()
    .from(recurring_transactions)
    .where(
      and(
        eq(recurring_transactions.user_id, userId),
        eq(recurring_transactions.is_active, 1),
        or(
          eq(recurring_transactions.day_of_month, today),
          today === lastDayOfMonth ? gt(recurring_transactions.day_of_month, lastDayOfMonth) : undefined,
        ),
      ),
    );

  // Charges this job has already logged today, by recurring template. Makes
  // the job safe to run more than once a day: the standalone process runs it
  // at startup and again at midnight, and a scheduled cron call can arrive
  // twice.
  const firedToday = await db
    .select({ recurring_id: transactions.recurring_id })
    .from(transactions)
    .where(
      and(
        eq(transactions.user_id, userId),
        eq(transactions.source, 'recurring'),
        gte(transactions.created_at, startOfPeriod('today', at)),
      ),
    );
  const alreadyFired = new Set(firedToday.map((row) => row.recurring_id));

  const rates = await getExchangeRates();
  const created: Transaction[] = [];
  for (const recurring of dueRows) {
    if (alreadyFired.has(recurring.id)) {
      continue;
    }
    const amountSgd = toSGD(recurring.amount, recurring.currency as Currency, rates);
    const now = Date.now();

    const [inserted] = await db
      .insert(transactions)
      .values({
        id: randomUUID(),
        user_id: userId,
        amount: recurring.amount,
        currency: recurring.currency,
        amount_sgd: amountSgd,
        merchant: recurring.merchant,
        category: recurring.category,
        source: 'recurring',
        card_name: 'Recurring',
        note: `Auto-logged recurring: ${recurring.merchant}`,
        recurring_id: recurring.id,
        created_at: now,
        updated_at: now,
      })
      .returning();

    created.push(mapTransactionRow(inserted));
  }

  return created;
}

export async function getRecurringFiredToday(userId: string): Promise<Transaction[]> {
  const start = startOfPeriod('today');
  const rows = await db
    .select()
    .from(transactions)
    .where(and(eq(transactions.user_id, userId), eq(transactions.source, 'recurring'), gte(transactions.created_at, start)))
    .orderBy(desc(transactions.created_at));
  return rows.map(mapTransactionRow);
}
