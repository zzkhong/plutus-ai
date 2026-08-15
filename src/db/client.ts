/**
 * Database connection singleton and initialization
 */

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import path from 'path';
import fs from 'fs';
import { config } from '../config';
import * as schema from './schema';

let dbInstance: ReturnType<typeof drizzle> | null = null;

/**
 * Initialize database connection and run migrations
 */
function initializeDatabase(): ReturnType<typeof drizzle> {
  const dbPath = config.DATABASE_URL;

  // Ensure data directory exists
  const dataDir = path.dirname(dbPath);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // Create or connect to database
  const sqliteDb = new Database(dbPath);

  // Enable foreign keys
  sqliteDb.pragma('foreign_keys = ON');

  // Initialize Drizzle
  const db = drizzle(sqliteDb, { schema });

  // Run migrations/schema initialization
  initializeSchema(sqliteDb);

  return db;
}

/**
 * Create tables if they don't exist
 */
function initializeSchema(sqliteDb: Database.Database): void {
  // Transactions table
  sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      amount INTEGER NOT NULL,
      currency TEXT NOT NULL,
      amount_sgd INTEGER NOT NULL,
      merchant TEXT NOT NULL,
      category TEXT NOT NULL,
      source TEXT NOT NULL,
      card_name TEXT NOT NULL,
      note TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);

  // Holdings table
  sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS holdings (
      id TEXT PRIMARY KEY,
      symbol TEXT NOT NULL,
      name TEXT NOT NULL,
      asset_class TEXT NOT NULL,
      quantity REAL NOT NULL,
      currency TEXT NOT NULL,
      market TEXT NOT NULL,
      cost_basis INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);

  // Budgets table
  sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS budgets (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      amount INTEGER NOT NULL,
      currency TEXT NOT NULL,
      amount_sgd INTEGER NOT NULL,
      period TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);

  // Recurring transactions table
  sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS recurring_transactions (
      id TEXT PRIMARY KEY,
      amount INTEGER NOT NULL,
      currency TEXT NOT NULL,
      merchant TEXT NOT NULL,
      category TEXT NOT NULL,
      day_of_month INTEGER NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);

  // User config table
  sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS user_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
}

/**
 * Get or create database instance
 */
export function getDb(): ReturnType<typeof drizzle> {
  if (!dbInstance) {
    dbInstance = initializeDatabase();
  }
  return dbInstance;
}

// Export singleton instance
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const db: any = getDb();
