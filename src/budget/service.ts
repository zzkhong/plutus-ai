/**
 * Budget CRUD service (Drizzle-backed).
 */

import { randomUUID } from 'crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { budget_alerts, budgets } from '../db/schema';
import { toSGD } from '../config';
import { getExchangeRates } from '../fx/rates';
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
  userId: string,
  category: Category,
  amount: number,
  currency: Currency = 'SGD',
): Promise<Budget> {
  const amountCents = Math.max(0, Math.round(amount * 100));
  const amountSgd = toSGD(amountCents, currency, await getExchangeRates());
  const now = Date.now();

  const existing = await db
    .select()
    .from(budgets)
    .where(and(eq(budgets.user_id, userId), eq(budgets.category, category)))
    .get();

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
      user_id: userId,
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

export async function removeBudget(userId: string, category: Category): Promise<void> {
  const matching = and(eq(budgets.user_id, userId), eq(budgets.category, category));
  // Alert rows are deleted explicitly rather than by ON DELETE CASCADE, which
  // Turso doesn't reliably enforce (see src/db/client.ts).
  await db.batch([
    db.delete(budget_alerts).where(inArray(budget_alerts.budget_id, db.select({ id: budgets.id }).from(budgets).where(matching))),
    db.delete(budgets).where(matching),
  ]);
}

export async function listBudgets(userId: string): Promise<Budget[]> {
  const rows = await db.select().from(budgets).where(eq(budgets.user_id, userId)).orderBy(budgets.category);
  return rows.map(mapBudgetRow);
}

export async function findBudgetByCategory(userId: string, category: Category): Promise<Budget | null> {
  const row = await db
    .select()
    .from(budgets)
    .where(and(eq(budgets.user_id, userId), eq(budgets.category, category)))
    .get();
  return row ? mapBudgetRow(row) : null;
}
