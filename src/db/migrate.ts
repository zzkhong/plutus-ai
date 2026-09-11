/**
 * Applies pending migrations from ./migrations to DATABASE_URL.
 *
 * Runs in three places: `npm run db:migrate` by hand, the Vercel build
 * (`npm run vercel-build`, so a deploy migrates Turso before the new code
 * serves traffic), and the standalone process's startup. Drizzle records
 * each migration in __drizzle_migrations and applies it once, all-or-nothing.
 */

import path from 'path';
import { migrate } from 'drizzle-orm/libsql/migrator';

export const MIGRATIONS_FOLDER = path.join(__dirname, 'migrations');

export async function runMigrations(): Promise<void> {
  // Imported lazily: ./client loads and validates the full config, and a
  // preview build — which skips migrating — may not have that config at all.
  const { getDb } = await import('./client');
  await migrate(getDb(), { migrationsFolder: MIGRATIONS_FOLDER });
}

async function main(): Promise<void> {
  // Preview deployments run the same build as production. Letting a preview
  // branch migrate the production database would apply an unreviewed schema
  // change to real data, so previews skip it.
  if (process.env.VERCEL_ENV === 'preview') {
    console.log('Skipping migrations on a Vercel preview deployment.');
    return;
  }

  console.log('Running migrations...');
  await runMigrations();
  console.log('Migrations applied.');
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Migration failed:', error);
    process.exit(1);
  });
}
