/**
 * Database schema definitions using Drizzle ORM
 */

import { sql } from 'drizzle-orm';
import {
  sqliteTable,
  text,
  integer,
  real,
  primaryKey,
} from 'drizzle-orm/sqlite-core';

// Transactions table
export const transactions = sqliteTable('transactions', {
  id: text('id').primaryKey(),
  amount: integer('amount').notNull(), // in cents
  currency: text('currency').notNull(),
  amount_sgd: integer('amount_sgd').notNull(), // normalized to SGD in cents
  merchant: text('merchant').notNull(),
  category: text('category').notNull(),
  source: text('source').notNull(),
  card_name: text('card_name').notNull(),
  note: text('note'),
  created_at: integer('created_at')
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  updated_at: integer('updated_at')
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

// Holdings (portfolio) table
export const holdings = sqliteTable('holdings', {
  id: text('id').primaryKey(),
  symbol: text('symbol').notNull(),
  name: text('name').notNull(),
  asset_class: text('asset_class').notNull(),
  quantity: real('quantity').notNull(),
  currency: text('currency').notNull(),
  market: text('market').notNull(),
  cost_basis: integer('cost_basis'), // optional, in cents
  created_at: integer('created_at')
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  updated_at: integer('updated_at')
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

// Budgets table
export const budgets = sqliteTable('budgets', {
  id: text('id').primaryKey(),
  category: text('category').notNull(),
  amount: integer('amount').notNull(), // in cents
  currency: text('currency').notNull(),
  amount_sgd: integer('amount_sgd').notNull(), // normalized to SGD in cents
  period: text('period').notNull(), // daily, weekly, monthly, yearly
  created_at: integer('created_at')
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  updated_at: integer('updated_at')
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

// Budget alert dedup table — one row per (budget, threshold, month) once sent
export const budget_alerts = sqliteTable('budget_alerts', {
  id: text('id').primaryKey(),
  budget_id: text('budget_id')
    .notNull()
    .references(() => budgets.id, { onDelete: 'cascade' }),
  threshold: integer('threshold').notNull(), // 80 or 100
  month: text('month').notNull(), // 'YYYY-MM'
  sent_at: integer('sent_at')
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

// Recurring transactions table
export const recurring_transactions = sqliteTable('recurring_transactions', {
  id: text('id').primaryKey(),
  amount: integer('amount').notNull(), // in cents
  currency: text('currency').notNull(),
  merchant: text('merchant').notNull(),
  category: text('category').notNull(),
  day_of_month: integer('day_of_month').notNull(),
  is_active: integer('is_active').notNull().default(1), // boolean stored as 0 or 1
  created_at: integer('created_at')
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  updated_at: integer('updated_at')
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

// User configuration table (key-value store)
export const user_config = sqliteTable(
  'user_config',
  {
    key: text('key').notNull(),
    value: text('value').notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.key] }),
  }),
);
