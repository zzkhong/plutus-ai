/**
 * Income: money coming in — salary, freelance, a refund. Stored apart from
 * transactions so it can never be counted as spending. It feeds /month's
 * savings rate and the month-end review.
 */

import { randomUUID } from 'crypto';
import { and, desc, eq, gte, lt } from 'drizzle-orm';
import { toSGD } from '../config';
import { db } from '../db';
import { income } from '../db/schema';
import { getExchangeRates } from '../fx/rates';
import { Currency, Income } from '../types';

export interface IncomeInput {
  amount: number; // in major units, e.g. 5000.00
  currency?: Currency;
  source?: string; // what it was, e.g. "Salary"
  note?: string;
  receivedAt?: Date;
}

function mapIncomeRow(row: typeof income.$inferSelect): Income {
  return {
    id: row.id,
    amount: row.amount,
    currency: row.currency as Currency,
    amount_sgd: row.amount_sgd,
    source: row.source,
    note: row.note ?? undefined,
    received_at: new Date(row.received_at),
    created_at: new Date(row.created_at),
  };
}

function sourceLabel(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim();
  return trimmed ? trimmed.charAt(0).toUpperCase() + trimmed.slice(1) : 'Income';
}

export async function logIncome(userId: string, data: IncomeInput): Promise<Income> {
  const amountCents = Math.max(0, Math.round(data.amount * 100));
  const currency = data.currency ?? 'SGD';
  const now = Date.now();

  const [inserted] = await db
    .insert(income)
    .values({
      id: randomUUID(),
      user_id: userId,
      amount: amountCents,
      currency,
      amount_sgd: toSGD(amountCents, currency, await getExchangeRates()),
      source: sourceLabel(data.source),
      note: data.note ?? null,
      received_at: data.receivedAt?.getTime() ?? now,
      created_at: now,
    })
    .returning();

  return mapIncomeRow(inserted);
}

/** Scoped to the user — the id arrives in button data a client could forge. */
export async function deleteIncome(userId: string, incomeId: string): Promise<Income | null> {
  const row = await db
    .select()
    .from(income)
    .where(and(eq(income.id, incomeId), eq(income.user_id, userId)))
    .get();
  if (!row) {
    return null;
  }
  await db.delete(income).where(and(eq(income.id, incomeId), eq(income.user_id, userId)));
  return mapIncomeRow(row);
}

/** Income received in [start, end), newest first. */
export async function listIncomeBetween(userId: string, start: Date, end: Date): Promise<Income[]> {
  const rows = await db
    .select()
    .from(income)
    .where(
      and(eq(income.user_id, userId), gte(income.received_at, start.getTime()), lt(income.received_at, end.getTime())),
    )
    .orderBy(desc(income.received_at));
  return rows.map(mapIncomeRow);
}

/** Total income received in [start, end), in SGD cents. */
export async function getIncomeTotal(userId: string, start: Date, end: Date): Promise<number> {
  const rows = await listIncomeBetween(userId, start, end);
  return rows.reduce((sum, row) => sum + row.amount_sgd, 0);
}
