/**
 * Portfolio holdings CRUD service (Drizzle-backed).
 */

import { randomUUID } from 'crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db';
import { holdings } from '../db/schema';
import { AssetClass, Currency } from '../types';
import { Broker, Holding, HoldingInput, ParsedHolding } from './types';

function mapHoldingRow(row: typeof holdings.$inferSelect): Holding {
  return {
    id: row.id,
    symbol: row.symbol,
    name: row.name,
    asset_class: row.asset_class as AssetClass,
    quantity: row.quantity,
    currency: row.currency as Currency,
    market: row.market,
    broker: (row.broker as Broker | null) ?? null,
    cost_basis: row.cost_basis ?? undefined,
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at),
  };
}

/** Manual (crypto/cash) holdings only — never touches broker-sourced rows. */
export async function addHolding(userId: string, input: HoldingInput): Promise<Holding> {
  const now = Date.now();
  const existing = await db
    .select()
    .from(holdings)
    .where(and(eq(holdings.user_id, userId), eq(holdings.symbol, input.symbol), isNull(holdings.broker)))
    .get();

  if (existing) {
    const [updated] = await db
      .update(holdings)
      .set({
        name: input.name,
        asset_class: input.asset_class,
        quantity: input.quantity,
        currency: input.currency,
        market: input.market,
        updated_at: now,
      })
      .where(eq(holdings.id, existing.id))
      .returning();
    return mapHoldingRow(updated);
  }

  const [inserted] = await db
    .insert(holdings)
    .values({
      id: randomUUID(),
      user_id: userId,
      symbol: input.symbol,
      name: input.name,
      asset_class: input.asset_class,
      quantity: input.quantity,
      currency: input.currency,
      market: input.market,
      broker: null,
      created_at: now,
      updated_at: now,
    })
    .returning();

  return mapHoldingRow(inserted);
}

/** Manual (crypto/cash) holdings only — never touches broker-sourced rows. */
export async function removeHolding(userId: string, symbol: string): Promise<void> {
  await db
    .delete(holdings)
    .where(and(eq(holdings.user_id, userId), eq(holdings.symbol, symbol), isNull(holdings.broker)));
}

/**
 * Full snapshot replace, scoped to one broker AND one user: wipes that
 * user's existing holdings for that broker and inserts the statement's
 * ending positions. Never touches another user's rows, the other broker's
 * rows, or manually-entered holdings. Transactional: both delete and insert
 * succeed or both roll back.
 */
export async function replaceHoldingsForBroker(
  userId: string,
  broker: Broker,
  parsed: ParsedHolding[],
): Promise<Holding[]> {
  if (parsed.length === 0) {
    throw new Error(
      'Refusing to replace holdings with an empty list — an empty statement is almost always a parse failure, not an emptied account.',
    );
  }

  const now = Date.now();

  const rows = parsed.map((h) => ({
    id: randomUUID(),
    user_id: userId,
    symbol: h.symbol,
    name: h.name,
    asset_class: h.asset_class,
    quantity: h.quantity,
    currency: h.currency,
    market: h.market,
    broker,
    created_at: now,
    updated_at: now,
  }));

  // A batch runs as one transaction on both a local file and Turso, so a
  // failed insert can't leave this broker's holdings deleted and empty.
  const [, inserted] = await db.batch([
    db.delete(holdings).where(and(eq(holdings.user_id, userId), eq(holdings.broker, broker))),
    db.insert(holdings).values(rows).returning(),
  ]);
  return inserted.map(mapHoldingRow);
}

export async function listHoldings(userId: string): Promise<Holding[]> {
  const rows = await db.select().from(holdings).where(eq(holdings.user_id, userId)).orderBy(holdings.symbol);
  return rows.map(mapHoldingRow);
}
