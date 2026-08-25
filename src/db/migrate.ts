/**
 * Database migration runner
 * Run this script to apply pending migrations to the database
 */

import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import Database from 'better-sqlite3';
import { config } from '../config/env';
import path from 'path';

export function runMigrations() {
  const sqlite = new Database(config.DATABASE_URL);
  const db = drizzle(sqlite);

  console.log('Running migrations...');
  migrate(db, { migrationsFolder: path.join(__dirname, 'migrations') });
  console.log('Migrations completed successfully!');

  sqlite.close();
}

// Run migrations if this file is executed directly
if (require.main === module) {
  runMigrations();
}
