/**
 * Database schema definitions using Drizzle ORM
 */

import { sql } from 'drizzle-orm';
import {
  index,
  sqliteTable,
  text,
  integer,
  real,
} from 'drizzle-orm/sqlite-core';

// Users table
export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  telegram_chat_id: text('telegram_chat_id').notNull().unique(),
  status: text('status').notNull(), // 'onboarding' | 'pending_approval' | 'approved'
  is_admin: integer('is_admin').notNull().default(0),
  llm_provider: text('llm_provider'), // 'gemini' for now; widened in a later slice
  llm_api_key_encrypted: text('llm_api_key_encrypted'),
  webhook_api_key: text('webhook_api_key').unique(),
  created_at: integer('created_at')
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  updated_at: integer('updated_at')
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

// Transactions table
export const transactions = sqliteTable('transactions', {
  id: text('id').primaryKey(),
  user_id: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  amount: integer('amount').notNull(), // in cents
  currency: text('currency').notNull(),
  amount_sgd: integer('amount_sgd').notNull(), // normalized to SGD in cents
  merchant: text('merchant').notNull(),
  category: text('category').notNull(),
  source: text('source').notNull(),
  card_name: text('card_name').notNull(),
  note: text('note'),
  // The recurring template that logged this row, if any — the recurring
  // job's idempotency key, so running it twice in a day can't double-log.
  recurring_id: text('recurring_id'),
  // When the money was spent: "yesterday" or a receipt's date, else the time
  // it was logged. Totals and budgets go by this; "latest" (undo, /recent,
  // corrections) goes by created_at. Nullable only because SQLite can't add a
  // NOT NULL column without a constant default — every write sets it, and
  // migration 0002 backfilled existing rows from created_at.
  spent_at: integer('spent_at'),
  created_at: integer('created_at')
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  updated_at: integer('updated_at')
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
}, (t) => [index('transactions_user_created_idx').on(t.user_id, t.created_at)]);

// Money coming in (salary, freelance, refunds), for /month's savings rate and
// the month-end review. Kept apart from transactions so an income can never
// be counted as spending.
export const income = sqliteTable('income', {
  id: text('id').primaryKey(),
  user_id: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  amount: integer('amount').notNull(), // in cents
  currency: text('currency').notNull(),
  amount_sgd: integer('amount_sgd').notNull(), // normalized to SGD in cents
  source: text('source').notNull(), // what it was, e.g. "Salary"
  note: text('note'),
  received_at: integer('received_at').notNull(),
  created_at: integer('created_at')
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
}, (t) => [index('income_user_received_idx').on(t.user_id, t.received_at)]);

// Holdings (portfolio) table
export const holdings = sqliteTable('holdings', {
  id: text('id').primaryKey(),
  user_id: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  symbol: text('symbol').notNull(),
  name: text('name').notNull(),
  asset_class: text('asset_class').notNull(),
  quantity: real('quantity').notNull(),
  currency: text('currency').notNull(),
  market: text('market').notNull(),
  broker: text('broker'), // 'ibkr' | 'moomoo' | null (null = manually entered: crypto/cash)
  cost_basis: integer('cost_basis'), // optional, in cents
  // Per-unit price on the statement the holding was imported from, in
  // `currency`, and the date that statement valued it at. Stocks are valued
  // with these; there are no live stock quotes. Null for chat entries.
  price: real('price'),
  price_as_of: integer('price_as_of'),
  // For a coin outside the built-in price table: the CoinGecko coin the
  // user picked from a search, since unrelated tokens share tickers.
  coingecko_id: text('coingecko_id'),
  created_at: integer('created_at')
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  updated_at: integer('updated_at')
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
}, (t) => [index('holdings_user_idx').on(t.user_id)]);

// Budgets table
export const budgets = sqliteTable('budgets', {
  id: text('id').primaryKey(),
  user_id: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  category: text('category').notNull(), // a Category, or 'Overall' for all spending
  amount: integer('amount').notNull(), // in cents
  currency: text('currency').notNull(),
  amount_sgd: integer('amount_sgd').notNull(), // normalized to SGD in cents
  period: text('period').notNull(), // always 'monthly' — budgets reset on the 1st
  created_at: integer('created_at')
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  updated_at: integer('updated_at')
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
}, (t) => [index('budgets_user_category_idx').on(t.user_id, t.category)]);

// Budget alert dedup table — one row per (budget, threshold, month) once sent
export const budget_alerts = sqliteTable('budget_alerts', {
  id: text('id').primaryKey(),
  user_id: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  budget_id: text('budget_id')
    .notNull()
    .references(() => budgets.id, { onDelete: 'cascade' }),
  threshold: integer('threshold').notNull(), // 80 or 100, or 0 for the pace warning
  month: text('month').notNull(), // 'YYYY-MM'
  sent_at: integer('sent_at')
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
}, (t) => [index('budget_alerts_budget_idx').on(t.budget_id, t.threshold, t.month)]);

// Recurring transactions table
export const recurring_transactions = sqliteTable('recurring_transactions', {
  id: text('id').primaryKey(),
  user_id: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
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
}, (t) => [index('recurring_transactions_user_idx').on(t.user_id)]);

// In-progress /split conversations, one row per chat. Persisted rather than
// held in memory because on Vercel consecutive messages can reach different
// function instances. Expiry is enforced on read — see src/split/state.ts.
export const split_sessions = sqliteTable('split_sessions', {
  chat_id: text('chat_id').primaryKey(), // Telegram chat id
  state: text('state').notNull(), // JSON-encoded SplitState
  updated_at: integer('updated_at')
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

// Live exchange rates, cached for a day across every function instance — see
// src/fx/rates.ts. One row, keyed by the base currency.
export const fx_rates = sqliteTable('fx_rates', {
  id: text('id').primaryKey(),
  rates: text('rates').notNull(), // JSON: units of each currency per 1 SGD
  fetched_at: integer('fetched_at').notNull(),
});

// Telegram updates being handled right now, one row each, so a chat's
// updates run in the order they were sent — see src/bot/middleware/sequence.ts.
// A row lives only while its update is handled.
export const chat_updates = sqliteTable(
  'chat_updates',
  {
    update_id: integer('update_id').primaryKey(), // Telegram's update_id, which only increases
    chat_id: text('chat_id').notNull(),
    started_at: integer('started_at').notNull(),
  },
  (t) => [index('chat_updates_chat_idx').on(t.chat_id, t.update_id)],
);
