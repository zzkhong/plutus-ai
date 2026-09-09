/**
 * Transaction and recurring expense service.
 */

import { randomUUID } from 'crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { and, desc, eq, gte, lt } from 'drizzle-orm';

import { config, toSGD } from '../config';
import { db } from '../db';
import { transactions } from '../db/schema';
import { Category, Currency, Transaction } from '../types';
import { inferCategory } from './categorizer';
import { resolveCurrency } from './currency-resolver';
import {
  Comparison,
  ExpenseInput,
  RecurringInput,
  SpendingPeriod,
  SpendingSummary,
} from './types';

function ensureDataDirectory(): void {
  const dataDir = path.dirname(config.DATABASE_URL);
  if (dataDir && dataDir !== '.') {
    fs.mkdirSync(dataDir, { recursive: true });
  }
}

function getSQLiteDb(): Database.Database {
  ensureDataDirectory();
  const sqliteDb = new Database(config.DATABASE_URL);
  return sqliteDb;
}

function centsFromAmount(amount: number): number {
  return Math.max(0, Math.round(amount * 100));
}

function startOfPeriod(period: SpendingPeriod): number {
  const now = new Date();
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
  const category = await inferCategory({ merchant, note: data.note, amount: amountCents });
  const now = Date.now();
  const amountSgd = toSGD(amountCents, normalizedCurrency);

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
    updates.category = await inferCategory({ merchant: row.merchant, note: value, amount: row.amount });
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
    updates.amount_sgd = toSGD(nextAmount, resolvedCurrency);
  } else if (normalizedField === 'currency') {
    const nextCurrency = resolveCurrency({
      currency: value as Currency,
      cardName: row.card_name,
      merchant: row.merchant,
      note: row.note ?? undefined,
    });
    updates.currency = nextCurrency;
    updates.amount_sgd = toSGD(row.amount, nextCurrency);
  }

  const [updated] = await db.update(transactions).set(updates).where(eq(transactions.id, row.id)).returning();
  return mapTransactionRow(updated);
}

export async function exportCSV(userId: string, year: number): Promise<string> {
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

  const exportDir = path.resolve('./data/exports');
  fs.mkdirSync(exportDir, { recursive: true });

  const filePath = path.join(exportDir, `expenses-${userId}-${year}.csv`);
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

  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
  return filePath;
}

// --- Recurring-transaction functions below are migrated in Task 7; left
// unchanged (raw SQL, no userId) for now. getSQLiteDb()/ensureDataDirectory()
// above stay in place until Task 7 removes them along with these. ---

export async function createRecurring(data: RecurringInput): Promise<any> {
  const db2 = getSQLiteDb();
  const amount = centsFromAmount(data.amount);
  const category = data.category ?? (await inferCategory({ merchant: data.merchant, amount }));
  const id = randomUUID();
  const now = Date.now();

  db2.prepare(
    `INSERT INTO recurring_transactions (id, amount, currency, merchant, category, day_of_month, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    amount,
    data.currency ?? 'SGD',
    data.merchant,
    category,
    data.day_of_month,
    data.is_active === undefined ? 1 : data.is_active ? 1 : 0,
    now,
    now,
  );

  const row = db2.prepare('SELECT * FROM recurring_transactions WHERE id = ?').get(id) as any;
  db2.close();
  return {
    ...row,
    is_active: Boolean(row.is_active),
    created_at: new Date(Number(row.created_at)),
    updated_at: new Date(Number(row.updated_at)),
  };
}

export async function pauseRecurring(id: string): Promise<void> {
  const db2 = getSQLiteDb();
  db2.prepare('UPDATE recurring_transactions SET is_active = 0, updated_at = ? WHERE id = ?').run(Date.now(), id);
  db2.close();
}

export async function removeRecurring(id: string): Promise<void> {
  const db2 = getSQLiteDb();
  db2.prepare('DELETE FROM recurring_transactions WHERE id = ?').run(id);
  db2.close();
}

export async function listRecurring(): Promise<any[]> {
  const db2 = getSQLiteDb();
  const rows = db2.prepare('SELECT * FROM recurring_transactions ORDER BY day_of_month ASC').all() as any[];
  db2.close();
  return rows.map((row) => ({
    ...row,
    is_active: Boolean(row.is_active),
    created_at: new Date(Number(row.created_at)),
    updated_at: new Date(Number(row.updated_at)),
  }));
}

export async function fireRecurringForToday(): Promise<Transaction[]> {
  const db2 = getSQLiteDb();
  const today = new Date().getDate();
  const recurringRows = db2
    .prepare('SELECT * FROM recurring_transactions WHERE is_active = 1 AND day_of_month = ?')
    .all(today) as any[];

  const created: Transaction[] = [];
  for (const recurring of recurringRows) {
    const amountSgd = toSGD(Number(recurring.amount), String(recurring.currency) as Currency);
    const insertedId = randomUUID();
    const now = Date.now();

    db2.prepare(
      `INSERT INTO transactions (id, user_id, amount, currency, amount_sgd, merchant, category, source, card_name, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      insertedId,
      'PLACEHOLDER_UNTIL_TASK_7',
      Number(recurring.amount),
      String(recurring.currency),
      amountSgd,
      String(recurring.merchant),
      String(recurring.category),
      'recurring',
      'Recurring',
      `Auto-logged recurring: ${recurring.merchant}`,
      now,
      now,
    );

    const insertedRow = db2.prepare('SELECT * FROM transactions WHERE id = ?').get(insertedId) as any;
    created.push(mapTransactionRow({ ...insertedRow, note: insertedRow.note } as typeof transactions.$inferSelect));
  }

  db2.close();
  return created;
}

export async function getRecurringFiredToday(): Promise<Transaction[]> {
  const start = startOfPeriod('today');
  const rows = await db
    .select()
    .from(transactions)
    .where(and(eq(transactions.source, 'recurring'), gte(transactions.created_at, start)))
    .orderBy(desc(transactions.created_at));
  return rows.map(mapTransactionRow);
}
