/**
 * Transaction and recurring expense service.
 *
 * A transaction has two times. spent_at is when the money went ("yesterday",
 * a receipt's date, otherwise the moment it was logged) — totals, budgets,
 * the month review and the export go by it. created_at is when it was logged
 * — "latest" for /undo, corrections and /recent goes by that.
 */

import { randomUUID } from 'crypto';
import { and, desc, eq, gt, gte, lt, or, sql } from 'drizzle-orm';

import { SUPPORTED_CURRENCIES, toSGD } from '../config';
import type { ExchangeRates } from '../config/currencies';
import { getExchangeRates } from '../fx/rates';
import { db } from '../db';
import { transactions, recurring_transactions } from '../db/schema';
import { Category, Currency, Transaction, RecurringTransaction } from '../types';
import { parseIsoDate } from '../utils/dates';
import { inferCategory, matchCategory } from './categorizer';
import { resolveCurrency } from './currency-resolver';
import {
  Comparison,
  CorrectionField,
  ExpenseInput,
  RecurringInput,
  SpendingPeriod,
  SpendingSummary,
} from './types';

const UNKNOWN_MERCHANT = 'Unknown merchant';

/**
 * When a row's money was spent. Falls back to created_at for a row without
 * spent_at: migration 0002 backfilled every existing row, but it runs during
 * the Vercel build, while the previous deployment is still live and logging
 * expenses without the column.
 */
const spentAtColumn = sql<number>`coalesce(${transactions.spent_at}, ${transactions.created_at})`;

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

/** Where a period ends: tomorrow for today and the last 7 days, the 1st of next month for a month. */
function endOfPeriod(period: SpendingPeriod, now: Date = new Date()): number {
  if (period === 'month') {
    return new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();
  }
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
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
    spent_at: new Date(row.spent_at ?? row.created_at),
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at),
  };
}

/**
 * The category this user last gave the same merchant (case-insensitively),
 * corrections included — a correction bumps updated_at. Null for a merchant
 * they've never logged.
 */
export async function rememberedCategory(userId: string, merchant: string): Promise<Category | null> {
  const key = merchant.trim().toLowerCase();
  if (!key || key === UNKNOWN_MERCHANT.toLowerCase()) {
    return null;
  }

  const row = await db
    .select({ category: transactions.category })
    .from(transactions)
    .where(and(eq(transactions.user_id, userId), sql`lower(${transactions.merchant}) = ${key}`))
    .orderBy(desc(transactions.updated_at))
    .limit(1)
    .get();
  return row ? matchCategory(row.category) : null;
}

/**
 * A new expense's category, from the cheapest reliable source:
 *
 * 1. what this user filed the same merchant under last time — their own
 *    choice, so it also carries their corrections forward;
 * 2. the category worked out upstream (the chat classifier's, the receipt
 *    reader's), which costs nothing extra;
 * 3. only then, a categorization call to the user's provider.
 *
 * Every chat expense used to make two LLM calls — classify, then categorize
 * — and throw the classifier's category away.
 */
async function resolveExpenseCategory(
  userId: string,
  input: { merchant: string; note?: string; amount: number; hint?: Category },
): Promise<Category> {
  return (
    (await rememberedCategory(userId, input.merchant)) ??
    input.hint ??
    (await inferCategory(userId, { merchant: input.merchant, note: input.note, amount: input.amount }))
  );
}

export async function logExpense(userId: string, data: ExpenseInput): Promise<Transaction> {
  const normalizedCurrency = resolveCurrency({
    currency: data.currency,
    cardName: data.cardName,
    merchant: data.merchant,
    note: data.note,
  });

  const amountCents = centsFromAmount(data.amount);
  const merchant = (data.merchant ?? UNKNOWN_MERCHANT).trim() || UNKNOWN_MERCHANT;
  const category = await resolveExpenseCategory(userId, {
    merchant,
    note: data.note,
    amount: amountCents,
    hint: data.categoryHint,
  });
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
      spent_at: data.spentAt?.getTime() ?? now,
      created_at: now,
      updated_at: now,
    })
    .returning();

  return mapTransactionRow(inserted);
}

async function latestTransactionRow(userId: string) {
  return db
    .select()
    .from(transactions)
    .where(eq(transactions.user_id, userId))
    .orderBy(desc(transactions.created_at))
    .limit(1)
    .get();
}

async function transactionRow(userId: string, transactionId: string) {
  // Scoped to the user: a transaction id arrives in button data a client
  // could forge, so an id alone must never reach someone else's row.
  return db
    .select()
    .from(transactions)
    .where(and(eq(transactions.id, transactionId), eq(transactions.user_id, userId)))
    .get();
}

export async function getTransaction(userId: string, transactionId: string): Promise<Transaction | null> {
  const row = await transactionRow(userId, transactionId);
  return row ? mapTransactionRow(row) : null;
}

/** The user's most recently logged expenses, newest first. */
export async function listRecentTransactions(userId: string, limit = 10): Promise<Transaction[]> {
  const rows = await db
    .select()
    .from(transactions)
    .where(eq(transactions.user_id, userId))
    .orderBy(desc(transactions.created_at))
    .limit(limit);
  return rows.map(mapTransactionRow);
}

export async function deleteTransaction(userId: string, transactionId: string): Promise<Transaction | null> {
  const row = await transactionRow(userId, transactionId);
  if (!row) {
    return null;
  }
  await db.delete(transactions).where(and(eq(transactions.id, row.id), eq(transactions.user_id, userId)));
  return mapTransactionRow(row);
}

export async function undoLastTransaction(userId: string): Promise<Transaction | null> {
  const row = await latestTransactionRow(userId);
  if (!row) {
    return null;
  }

  await db.delete(transactions).where(eq(transactions.id, row.id));
  return mapTransactionRow(row);
}

/** Every expense spent in [start, end), newest first. */
export async function listTransactionsBetween(userId: string, start: Date, end: Date): Promise<Transaction[]> {
  const rows = await db
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.user_id, userId),
        gte(spentAtColumn, start.getTime()),
        lt(spentAtColumn, end.getTime()),
      ),
    )
    .orderBy(desc(spentAtColumn), desc(transactions.created_at));
  return rows.map(mapTransactionRow);
}

export function summarizeTransactions(period: SpendingPeriod, rows: Transaction[]): SpendingSummary {
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
    topExpenses: rows.slice(0, 5),
  };
}

/** Spending for today, the last 7 days, or `now`'s calendar month (`now` is injectable for tests). */
export async function getSpendingSummary(
  userId: string,
  period: SpendingPeriod,
  now: Date = new Date(),
): Promise<SpendingSummary> {
  const rows = await listTransactionsBetween(
    userId,
    new Date(startOfPeriod(period, now)),
    new Date(endOfPeriod(period, now)),
  );
  return summarizeTransactions(period, rows);
}

export async function getSpendingByCategory(
  userId: string,
  period: SpendingPeriod,
  now: Date = new Date(),
): Promise<{ category: string; total: number }[]> {
  const summary = await getSpendingSummary(userId, period, now);
  return Object.entries(summary.byCategory).map(([category, total]) => ({ category, total }));
}

export async function getTopExpenses(userId: string, period: SpendingPeriod, limit = 5): Promise<Transaction[]> {
  const rows = await listTransactionsBetween(userId, new Date(startOfPeriod(period)), new Date(endOfPeriod(period)));
  return rows.slice(0, limit);
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

/**
 * Changes one field of a transaction: the given one, or with a null id the
 * user's most recently logged. Returns null when there's no such
 * transaction for this user.
 */
export async function correctTransaction(
  userId: string,
  transactionId: string | null,
  field: CorrectionField | string,
  value: string,
): Promise<Transaction | null> {
  const row = transactionId ? await transactionRow(userId, transactionId) : await latestTransactionRow(userId);

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
  } else if (normalizedField === 'date') {
    // The caller has already refused future dates; an unreadable one changes nothing.
    const spentAt = parseIsoDate(value);
    if (spentAt) {
      updates.spent_at = spentAt.getTime();
    }
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

export async function correctLastTransaction(userId: string, field: string, value: string): Promise<Transaction | null> {
  return correctTransaction(userId, null, field, value);
}

/** Files a transaction under the category the user picked. */
export async function setTransactionCategory(
  userId: string,
  transactionId: string,
  category: Category,
): Promise<Transaction | null> {
  const [updated] = await db
    .update(transactions)
    .set({ category, updated_at: Date.now() })
    .where(and(eq(transactions.id, transactionId), eq(transactions.user_id, userId)))
    .returning();
  return updated ? mapTransactionRow(updated) : null;
}

export interface CsvExport {
  year: number;
  filename: string;
  content: string;
  rowCount: number;
}

/** Builds one calendar year of the user's transactions as CSV, in memory — nothing touches disk. */
export async function exportCSV(userId: string, year: number): Promise<CsvExport> {
  const rows = await listTransactionsBetween(userId, new Date(year, 0, 1), new Date(year + 1, 0, 1));

  const lines = [
    ['id', 'amount', 'currency', 'amount_sgd', 'merchant', 'category', 'source', 'card_name', 'note', 'spent_at', 'created_at'].join(','),
    ...rows.map((row) =>
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
        row.spent_at.getTime(),
        row.created_at.getTime(),
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

/** Letters and digits only, lower-cased: "Disney+ Hotstar" and "disney hotstar" are one name. */
function merchantKey(merchant: string): string {
  return merchant.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** The user's recurring charge for this merchant, compared ignoring case and punctuation. */
export async function findRecurringForMerchant(userId: string, merchant: string): Promise<RecurringTransaction | null> {
  const key = merchantKey(merchant);
  return (await listRecurring(userId)).find((charge) => merchantKey(charge.merchant) === key) ?? null;
}

/** Names shorter than this only match exactly, so "tv" can't catch half the list. */
const MIN_PARTIAL_MATCH = 3;

/**
 * The user's recurring charges a name refers to: an exact match (ignoring
 * case and punctuation) if there is one, otherwise every charge whose name
 * contains it or sits inside it — "Netflix Premium" finds "Netflix",
 * "spotify" finds "Spotify Family". More than one back means the caller
 * should ask which.
 */
export async function matchRecurring(userId: string, name: string): Promise<RecurringTransaction[]> {
  const key = merchantKey(name);
  if (!key) {
    return [];
  }
  const charges = await listRecurring(userId);
  const exact = charges.filter((charge) => merchantKey(charge.merchant) === key);
  if (exact.length > 0 || key.length < MIN_PARTIAL_MATCH) {
    return exact;
  }
  return charges.filter((charge) => {
    const chargeKey = merchantKey(charge.merchant);
    return chargeKey.length >= MIN_PARTIAL_MATCH && (chargeKey.includes(key) || key.includes(chargeKey));
  });
}

/**
 * Saves a monthly recurring charge. One the user already has for the same
 * merchant is updated in place — its name, and its category and currency
 * unless new ones are given, are kept. "Netflix is now $17.98 every 5th"
 * used to add a second Netflix charge, and both were logged every month.
 */
export async function createRecurring(userId: string, data: RecurringInput): Promise<RecurringTransaction> {
  const amount = centsFromAmount(data.amount);
  const existing = await findRecurringForMerchant(userId, data.merchant);
  const category =
    data.category ??
    existing?.category ??
    (await resolveExpenseCategory(userId, { merchant: data.merchant, amount }));
  const now = Date.now();

  if (existing) {
    const [updated] = await db
      .update(recurring_transactions)
      .set({
        amount,
        currency: data.currency ?? existing.currency,
        category,
        day_of_month: data.day_of_month,
        is_active: data.is_active === false ? 0 : 1,
        updated_at: now,
      })
      .where(and(eq(recurring_transactions.id, existing.id), eq(recurring_transactions.user_id, userId)))
      .returning();
    return mapRecurringRow(updated);
  }

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

/** Removes one of the user's recurring charges; returns it, or null if they had no such charge. */
export async function removeRecurring(userId: string, id: string): Promise<RecurringTransaction | null> {
  const [removed] = await db
    .delete(recurring_transactions)
    .where(and(eq(recurring_transactions.id, id), eq(recurring_transactions.user_id, userId)))
    .returning();
  return removed ? mapRecurringRow(removed) : null;
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
    if (!alreadyFired.has(recurring.id)) {
      created.push(await insertRecurringCharge(userId, recurring, rates));
    }
  }

  return created;
}

/** Logs one recurring charge as a transaction, tagged with its template's recurring_id. */
async function insertRecurringCharge(
  userId: string,
  recurring: typeof recurring_transactions.$inferSelect,
  rates: ExchangeRates,
): Promise<Transaction> {
  const now = Date.now();
  const [inserted] = await db
    .insert(transactions)
    .values({
      id: randomUUID(),
      user_id: userId,
      amount: recurring.amount,
      currency: recurring.currency,
      amount_sgd: toSGD(recurring.amount, recurring.currency as Currency, rates),
      merchant: recurring.merchant,
      category: recurring.category,
      source: 'recurring',
      card_name: 'Recurring',
      note: `Auto-logged recurring: ${recurring.merchant}`,
      recurring_id: recurring.id,
      spent_at: now,
      created_at: now,
      updated_at: now,
    })
    .returning();
  return mapTransactionRow(inserted);
}

/** Whether a charge on `dayOfMonth` is due on `at`; a day the month lacks falls on its last day. */
function isDueOn(dayOfMonth: number, at: Date): boolean {
  const today = at.getDate();
  const lastDayOfMonth = new Date(at.getFullYear(), at.getMonth() + 1, 0).getDate();
  return dayOfMonth === today || (today === lastDayOfMonth && dayOfMonth > lastDayOfMonth);
}

/**
 * Logs a recurring charge straight away when it's due today and nothing has
 * logged it yet today. The daily job runs just after midnight, so without
 * this a charge added on its due day would wait a month. The job still
 * skips it later, by recurring_id. Returns the transaction, or null.
 */
export async function logRecurringIfDue(userId: string, recurringId: string, at: Date = new Date()): Promise<Transaction | null> {
  const recurring = await db
    .select()
    .from(recurring_transactions)
    .where(
      and(
        eq(recurring_transactions.id, recurringId),
        eq(recurring_transactions.user_id, userId),
        eq(recurring_transactions.is_active, 1),
      ),
    )
    .get();
  if (!recurring || !isDueOn(recurring.day_of_month, at)) {
    return null;
  }

  const loggedToday = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(
      and(
        eq(transactions.user_id, userId),
        eq(transactions.recurring_id, recurring.id),
        gte(transactions.created_at, startOfPeriod('today', at)),
      ),
    )
    .get();
  if (loggedToday) {
    return null;
  }

  return insertRecurringCharge(userId, recurring, await getExchangeRates());
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
