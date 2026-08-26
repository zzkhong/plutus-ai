/**
 * Budget CRUD service (Drizzle-backed).
 */

import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { budgets } from '../db/schema';
import { toSGD } from '../config';
import { Category, Currency } from '../types';
import { Budget } from './types';

function mapBudgetRow(row: typeof budgets.$inferSelect): Budget {
  return {
    id: row.id,
    category: row.category as Category,
    amount: row.amount,
    currency: row.currency as Currency,
    amount_sgd: row.amount_sgd,
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at),
  };
}

export async function setBudget(
  category: Category,
  amount: number,
  currency: Currency = 'SGD',
): Promise<Budget> {
  const amountCents = Math.max(0, Math.round(amount * 100));
  const amountSgd = toSGD(amountCents, currency);
  const now = Date.now();

  const existing = await db.select().from(budgets).where(eq(budgets.category, category)).get();

  if (existing) {
    const [updated] = await db
      .update(budgets)
      .set({ amount: amountCents, currency, amount_sgd: amountSgd, updated_at: now })
      .where(eq(budgets.id, existing.id))
      .returning();
    return mapBudgetRow(updated);
  }

  const [inserted] = await db
    .insert(budgets)
    .values({
      id: randomUUID(),
      category,
      amount: amountCents,
      currency,
      amount_sgd: amountSgd,
      period: 'monthly',
      created_at: now,
      updated_at: now,
    })
    .returning();

  return mapBudgetRow(inserted);
}

export async function removeBudget(category: Category): Promise<void> {
  await db.delete(budgets).where(eq(budgets.category, category));
}

export async function listBudgets(): Promise<Budget[]> {
  const rows = await db.select().from(budgets).orderBy(budgets.category);
  return rows.map(mapBudgetRow);
}

export async function findBudgetByCategory(category: Category): Promise<Budget | null> {
  const row = await db.select().from(budgets).where(eq(budgets.category, category)).get();
  return row ? mapBudgetRow(row) : null;
}
