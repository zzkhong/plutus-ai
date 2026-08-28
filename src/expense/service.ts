/**
 * Transaction and recurring expense service.
 */

import { randomUUID } from 'crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

import { config, toSGD } from '../config';
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
  const db = new Database(config.DATABASE_URL);
  // Tables are created via Drizzle migrations (see src/db/migrations/)
  return db;
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

function mapTransactionRow(row: any): Transaction {
  return {
    id: String(row.id),
    amount: Number(row.amount),
    currency: String(row.currency) as Currency,
    amount_sgd: Number(row.amount_sgd),
    merchant: String(row.merchant),
    category: String(row.category) as Category,
    source: String(row.source),
    card_name: String(row.card_name),
    note: row.note ? String(row.note) : undefined,
    created_at: new Date(Number(row.created_at)),
    updated_at: new Date(Number(row.updated_at)),
  };
}

export async function logExpense(data: ExpenseInput): Promise<Transaction> {
  const db = getSQLiteDb();
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
  const id = randomUUID();
  const amountSgd = toSGD(amountCents, normalizedCurrency);

  db.prepare(
    `INSERT INTO transactions (id, amount, currency, amount_sgd, merchant, category, source, card_name, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    amountCents,
    normalizedCurrency,
    amountSgd,
    merchant,
    category,
    data.source ?? 'text',
    data.cardName ?? 'General',
    data.note ?? null,
    now,
    now,
  );

  const row = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id) as any;
  db.close();
  return mapTransactionRow(row);
}

export async function undoLastTransaction(): Promise<Transaction | null> {
  const db = getSQLiteDb();
  const row = db.prepare('SELECT * FROM transactions ORDER BY created_at DESC LIMIT 1').get() as any;

  if (!row) {
    db.close();
    return null;
  }

  db.prepare('DELETE FROM transactions WHERE id = ?').run(row.id);
  const removed = mapTransactionRow(row);
  db.close();
  return removed;
}

export async function getSpendingSummary(period: SpendingPeriod): Promise<SpendingSummary> {
  const db = getSQLiteDb();
  const start = startOfPeriod(period);
  const rows = db
    .prepare('SELECT * FROM transactions WHERE created_at >= ? ORDER BY created_at DESC')
    .all(start) as any[];

  const byCategory: Record<string, number> = {};
  const byCategoryCount: Record<string, number> = {};
  let total = 0;

  for (const row of rows) {
    total += Number(row.amount_sgd);
    const category = String(row.category);
    byCategory[category] = (byCategory[category] ?? 0) + Number(row.amount_sgd);
    byCategoryCount[category] = (byCategoryCount[category] ?? 0) + 1;
  }

  const summary: SpendingSummary = {
    period,
    total,
    count: rows.length,
    byCategory,
    byCategoryCount,
    topExpenses: rows.slice(0, 5).map((row) => mapTransactionRow(row)),
  };

  db.close();
  return summary;
}

export async function getSpendingByCategory(period: SpendingPeriod): Promise<{ category: string; total: number }[]> {
  const summary = await getSpendingSummary(period);
  return Object.entries(summary.byCategory).map(([category, total]) => ({ category, total }));
}

export async function getTopExpenses(period: SpendingPeriod, limit = 5): Promise<Transaction[]> {
  const db = getSQLiteDb();
  const start = startOfPeriod(period);
  const rows = db
    .prepare('SELECT * FROM transactions WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?')
    .all(start, limit) as any[];
  db.close();
  return rows.map((row) => mapTransactionRow(row));
}

export async function compareSpending(period1: SpendingPeriod, period2: SpendingPeriod): Promise<Comparison> {
  const summaryA = await getSpendingSummary(period1);
  const summaryB = await getSpendingSummary(period2);
  return {
    period1: summaryA,
    period2: summaryB,
    delta: summaryA.total - summaryB.total,
  };
}

export async function createRecurring(data: RecurringInput): Promise<any> {
  const db = getSQLiteDb();
  const amount = centsFromAmount(data.amount);
  const category = data.category ?? (await inferCategory({ merchant: data.merchant, amount }));
  const id = randomUUID();
  const now = Date.now();

  db.prepare(
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

  const row = db.prepare('SELECT * FROM recurring_transactions WHERE id = ?').get(id) as any;
  db.close();
  return {
    ...row,
    is_active: Boolean(row.is_active),
    created_at: new Date(Number(row.created_at)),
    updated_at: new Date(Number(row.updated_at)),
  };
}

export async function pauseRecurring(id: string): Promise<void> {
  const db = getSQLiteDb();
  db.prepare('UPDATE recurring_transactions SET is_active = 0, updated_at = ? WHERE id = ?').run(Date.now(), id);
  db.close();
}

export async function removeRecurring(id: string): Promise<void> {
  const db = getSQLiteDb();
  db.prepare('DELETE FROM recurring_transactions WHERE id = ?').run(id);
  db.close();
}

export async function listRecurring(): Promise<any[]> {
  const db = getSQLiteDb();
  const rows = db.prepare('SELECT * FROM recurring_transactions ORDER BY day_of_month ASC').all() as any[];
  db.close();
  return rows.map((row) => ({
    ...row,
    is_active: Boolean(row.is_active),
    created_at: new Date(Number(row.created_at)),
    updated_at: new Date(Number(row.updated_at)),
  }));
}

export async function fireRecurringForToday(): Promise<Transaction[]> {
  const db = getSQLiteDb();
  const today = new Date().getDate();
  const recurringRows = db
    .prepare('SELECT * FROM recurring_transactions WHERE is_active = 1 AND day_of_month = ?')
    .all(today) as any[];

  const created: Transaction[] = [];
  for (const recurring of recurringRows) {
    const amountSgd = toSGD(Number(recurring.amount), String(recurring.currency) as Currency);
    const insertedId = randomUUID();
    const now = Date.now();

    db.prepare(
      `INSERT INTO transactions (id, amount, currency, amount_sgd, merchant, category, source, card_name, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      insertedId,
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

    const insertedRow = db.prepare('SELECT * FROM transactions WHERE id = ?').get(insertedId) as any;
    created.push(mapTransactionRow(insertedRow));
  }

  db.close();
  return created;
}

export async function getRecurringFiredToday(): Promise<Transaction[]> {
  const db = getSQLiteDb();
  const start = startOfPeriod('today');
  const rows = db
    .prepare("SELECT * FROM transactions WHERE source = 'recurring' AND created_at >= ? ORDER BY created_at DESC")
    .all(start) as any[];
  db.close();
  return rows.map((row) => mapTransactionRow(row));
}

export async function correctLastTransaction(field: string, value: string): Promise<Transaction | null> {
  const db = getSQLiteDb();
  const row = db.prepare('SELECT * FROM transactions ORDER BY created_at DESC LIMIT 1').get() as any;

  if (!row) {
    db.close();
    return null;
  }

  const normalizedField = field.toLowerCase();
  let updateSql = 'UPDATE transactions SET updated_at = ?';
  const params: any[] = [Date.now()];

  if (normalizedField === 'merchant') {
    updateSql += ', merchant = ?';
    params.push(value);
  } else if (normalizedField === 'category') {
    const category = await inferCategory({ merchant: row.merchant, note: value, amount: row.amount });
    updateSql += ', category = ?';
    params.push(category);
  } else if (normalizedField === 'note') {
    updateSql += ', note = ?';
    params.push(value);
  } else if (normalizedField === 'amount') {
    const nextAmount = centsFromAmount(Number(value));
    const resolvedCurrency = resolveCurrency({
      currency: row.currency,
      cardName: row.card_name,
      merchant: row.merchant,
      note: row.note,
    });
    updateSql += ', amount = ?, amount_sgd = ?';
    params.push(nextAmount, toSGD(nextAmount, resolvedCurrency));
  } else if (normalizedField === 'currency') {
    const nextCurrency = resolveCurrency({ currency: value as Currency, cardName: row.card_name, merchant: row.merchant, note: row.note });
    updateSql += ', currency = ?, amount_sgd = ?';
    params.push(nextCurrency, toSGD(Number(row.amount), nextCurrency));
  }

  updateSql += ' WHERE id = ?';
  params.push(row.id);

  db.prepare(updateSql).run(...params);

  const updated = db.prepare('SELECT * FROM transactions WHERE id = ?').get(row.id) as any;
  db.close();
  return mapTransactionRow(updated);
}

export async function exportCSV(year: number): Promise<string> {
  const db = getSQLiteDb();
  const rows = db
    .prepare('SELECT * FROM transactions WHERE created_at >= ? AND created_at < ? ORDER BY created_at DESC')
    .all(new Date(year, 0, 1).getTime(), new Date(year + 1, 0, 1).getTime()) as any[];

  const exportDir = path.resolve('./data/exports');
  fs.mkdirSync(exportDir, { recursive: true });

  const filePath = path.join(exportDir, `expenses-${year}.csv`);
  const lines = [
    ['id', 'amount', 'currency', 'amount_sgd', 'merchant', 'category', 'source', 'card_name', 'note', 'created_at'].join(','),
    ...rows.map((row) =>
      [
        row.id,
        Number(row.amount),
        row.currency,
        Number(row.amount_sgd),
        String(row.merchant),
        String(row.category),
        String(row.source),
        String(row.card_name),
        row.note ?? '',
        Number(row.created_at),
      ]
        .map((value) => `"${String(value).replace(/"/g, '""')}"`)
        .join(','),
    ),
  ];

  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
  db.close();
  return filePath;
}
