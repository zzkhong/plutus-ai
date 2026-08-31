/**
 * Portfolio holdings CRUD service (Drizzle-backed).
 */

import { randomUUID } from 'crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { db, getSQLiteDb } from '../db';
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
export async function addHolding(input: HoldingInput): Promise<Holding> {
  const now = Date.now();
  const existing = await db
    .select()
    .from(holdings)
    .where(and(eq(holdings.symbol, input.symbol), isNull(holdings.broker)))
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
export async function removeHolding(symbol: string): Promise<void> {
  await db.delete(holdings).where(and(eq(holdings.symbol, symbol), isNull(holdings.broker)));
}

/**
 * Full snapshot replace, scoped to one broker: wipes all existing holdings
 * for that broker and inserts the statement's ending positions. Never
 * touches the other broker's rows or manually-entered holdings.
 * Transactional: both delete and insert succeed or both roll back.
 */
export async function replaceHoldingsForBroker(broker: Broker, parsed: ParsedHolding[]): Promise<Holding[]> {
  if (parsed.length === 0) {
    throw new Error(
      'Refusing to replace holdings with an empty list — an empty statement is almost always a parse failure, not an emptied account.',
    );
  }

  const now = Date.now();

  // Use raw better-sqlite3 transaction for atomicity
  const sqliteDb = getSQLiteDb();
  return sqliteDb.transaction(() => {
    db.delete(holdings).where(eq(holdings.broker, broker)).run();

    const rows = parsed.map((h) => ({
      id: randomUUID(),
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

    const inserted = db.insert(holdings).values(rows).returning().all();
    return inserted.map(mapHoldingRow);
  })();
}

export async function listHoldings(): Promise<Holding[]> {
  const rows = await db.select().from(holdings).orderBy(holdings.symbol);
  return rows.map(mapHoldingRow);
}
