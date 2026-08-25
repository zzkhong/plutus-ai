/**
 * Database connection singleton and initialization
 */

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
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

  // Run migrations automatically on startup
  try {
    migrate(db, { migrationsFolder: path.join(__dirname, 'migrations') });
  } catch (error) {
    console.error('Failed to run migrations:', error);
    throw error;
  }

  return db;
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
